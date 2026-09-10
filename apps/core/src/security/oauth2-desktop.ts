import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

import type { SecretStore } from "./secret-store.ts";

export type FetchTransport = (
    input: string | URL,
    init?: RequestInit,
) => Promise<Response>;

export interface OAuth2DesktopConfig {
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly scopes: readonly string[];
    /** Scopes expected in access-token responses; defaults to every requested scope. */
    readonly accessTokenScopes?: readonly string[];
    readonly tokenSecretKey: string;
    readonly redirectPath?: `/${string}`;
    readonly redirectHost?: "127.0.0.1" | "localhost";
    readonly additionalAuthorizationParameters?: Readonly<Record<string, string>>;
}

export interface OAuth2TokenSet {
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly tokenType: string;
    readonly scopes: readonly string[];
    readonly expiresAt: Date;
}

export interface OAuth2AuthorizationState {
    readonly authorized: boolean;
    readonly expiresAt?: Date;
    readonly scopes: readonly string[];
    readonly canRefresh: boolean;
}

interface StoredOAuth2TokenSet {
    readonly version: 1;
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly tokenType: string;
    readonly scopes: readonly string[];
    readonly expiresAt: string;
}

interface TokenEndpointResponse {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
    scope?: unknown;
    error?: unknown;
}

export interface AuthorizeInteractiveOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly openAuthorizationUrl?: (url: URL) => Promise<void> | void;
}

export interface AccessTokenOptions {
    readonly signal?: AbortSignal;
    readonly forceRefresh?: boolean;
    readonly minValidityMs?: number;
}

export class OAuth2Error extends Error {
    readonly code:
        | "configuration"
        | "authorization_denied"
        | "state_mismatch"
        | "timeout"
        | "token_exchange"
        | "reauthentication_required";

    constructor(
        message: string,
        code: OAuth2Error["code"],
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "OAuth2Error";
        this.code = code;
    }
}

/** RFC 7636 verifier using the unreserved character set. */
export function createPkceVerifier(): string {
    return randomBytes(64).toString("base64url");
}

export function createPkceChallenge(verifier: string): string {
    return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Desktop OAuth client with PKCE, loopback redirect, refresh, and encrypted storage. */
export class OAuth2DesktopClient {
    private readonly config: Required<Pick<OAuth2DesktopConfig, "redirectPath">>
        & OAuth2DesktopConfig;
    private readonly secretStore: SecretStore;
    private readonly transport: FetchTransport;
    private cachedTokens: OAuth2TokenSet | null | undefined;
    private refreshInFlight?: Promise<OAuth2TokenSet>;

    constructor(
        config: OAuth2DesktopConfig,
        secretStore: SecretStore,
        transport: FetchTransport = globalThis.fetch,
    ) {
        validateOAuthConfig(config);
        this.config = {
            ...config,
            redirectPath: config.redirectPath ?? "/oauth2/callback",
        };
        this.secretStore = secretStore;
        this.transport = transport;
    }

    async authorizeInteractive(
        options: AuthorizeInteractiveOptions = {},
    ): Promise<OAuth2AuthorizationState> {
        options.signal?.throwIfAborted();
        const timeoutMs = options.timeoutMs ?? 120_000;
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
            throw new OAuth2Error("Timeout OAuth inválido.", "configuration");
        }

        const state = randomBytes(32).toString("base64url");
        const verifier = createPkceVerifier();
        const server = createServer();
        const callbackAbortController = new AbortController();
        let callback: Promise<string> | undefined;

        try {
            const redirectHost = this.config.redirectHost ?? "127.0.0.1";
            const port = await listenOnLoopback(server, redirectHost, options.signal);
            const redirectUri = `http://${redirectHost}:${port}${this.config.redirectPath}`;
            const authorizationUrl = this.buildAuthorizationUrl(
                redirectUri,
                state,
                createPkceChallenge(verifier),
            );

            callback = waitForAuthorizationCallback(server, {
                expectedPath: this.config.redirectPath,
                expectedState: state,
                timeoutMs,
                signal: options.signal
                    ? AbortSignal.any([options.signal, callbackAbortController.signal])
                    : callbackAbortController.signal,
            });
            // The browser opener can be slow or fail before this promise is
            // awaited. Mark the callback rejection as observed immediately;
            // awaiting the original promise below still preserves its error.
            void callback.catch(() => undefined);

            await (options.openAuthorizationUrl ?? openSystemBrowser)(authorizationUrl);
            const code = await callback;
            const tokens = await this.exchangeAuthorizationCode(
                code,
                redirectUri,
                verifier,
                options.signal,
            );
            await this.persistTokens(tokens, options.signal);
            return authorizationState(tokens);
        } catch (error) {
            callbackAbortController.abort(error);
            await callback?.catch(() => undefined);
            throw error;
        } finally {
            callbackAbortController.abort(new DOMException(
                "Fluxo OAuth encerrado.",
                "AbortError",
            ));
            await callback?.catch(() => undefined);
            await closeServer(server);
        }
    }

    async getAccessToken(options: AccessTokenOptions = {}): Promise<string> {
        options.signal?.throwIfAborted();
        const tokens = await this.loadTokens(options.signal);
        const minValidityMs = options.minValidityMs ?? 60_000;

        if (
            !options.forceRefresh
            && tokens
            && this.hasRequiredScopes(tokens)
            && tokens.expiresAt.getTime() - Date.now() > minValidityMs
        ) {
            return tokens.accessToken;
        }

        if (tokens && !this.hasRequiredScopes(tokens)) {
            throw new OAuth2Error(
                "Novos escopos exigem autenticação interativa.",
                "reauthentication_required",
            );
        }

        if (!tokens?.refreshToken) {
            throw new OAuth2Error(
                "Autenticação interativa necessária.",
                "reauthentication_required",
            );
        }

        const refreshed = await this.refreshTokens(tokens, options.signal);
        return refreshed.accessToken;
    }

    async getAuthorizationState(signal?: AbortSignal): Promise<OAuth2AuthorizationState> {
        return authorizationState(await this.loadTokens(signal));
    }

    async clearTokens(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        this.cachedTokens = null;
        await this.secretStore.delete(this.config.tokenSecretKey, { signal });
    }

    private buildAuthorizationUrl(
        redirectUri: string,
        state: string,
        challenge: string,
    ): URL {
        const url = new URL(this.config.authorizationEndpoint);
        const parameters: Record<string, string> = {
            ...this.config.additionalAuthorizationParameters,
            response_type: "code",
            client_id: this.config.clientId,
            redirect_uri: redirectUri,
            scope: this.config.scopes.join(" "),
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
        };

        for (const [key, value] of Object.entries(parameters)) {
            url.searchParams.set(key, value);
        }
        return url;
    }

    private async exchangeAuthorizationCode(
        code: string,
        redirectUri: string,
        verifier: string,
        signal?: AbortSignal,
    ): Promise<OAuth2TokenSet> {
        const form = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: this.config.clientId,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        });
        if (this.config.clientSecret) {
            form.set("client_secret", this.config.clientSecret);
        }

        return await this.requestTokens(form, undefined, signal);
    }

    private async refreshTokens(
        current: OAuth2TokenSet,
        signal?: AbortSignal,
    ): Promise<OAuth2TokenSet> {
        if (this.refreshInFlight) return await this.refreshInFlight;

        this.refreshInFlight = (async () => {
            const form = new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: current.refreshToken!,
                client_id: this.config.clientId,
            });
            if (this.config.clientSecret) {
                form.set("client_secret", this.config.clientSecret);
            }

            const refreshed = await this.requestTokens(form, current, signal);
            await this.persistTokens(refreshed, signal);
            return refreshed;
        })();

        try {
            return await this.refreshInFlight;
        } finally {
            this.refreshInFlight = undefined;
        }
    }

    private async requestTokens(
        form: URLSearchParams,
        previous: OAuth2TokenSet | undefined,
        signal?: AbortSignal,
    ): Promise<OAuth2TokenSet> {
        let response: Response;
        try {
            response = await this.transport(this.config.tokenEndpoint, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: form,
                signal,
            });
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            throw new OAuth2Error(
                "Falha de rede durante a autenticação OAuth.",
                "token_exchange",
                { cause: error },
            );
        }

        const payload = await readJsonObject<TokenEndpointResponse>(response);
        if (!response.ok || typeof payload.access_token !== "string") {
            // Never include the remote payload: providers sometimes echo sensitive data.
            throw new OAuth2Error(
                "O servidor OAuth recusou a troca ou renovação do token.",
                "token_exchange",
            );
        }

        const parsedExpiresIn = typeof payload.expires_in === "number"
            ? payload.expires_in
            : Number(payload.expires_in ?? 3600);
        const expiresIn = Number.isFinite(parsedExpiresIn) ? parsedExpiresIn : 3600;
        const scopes = typeof payload.scope === "string"
            ? payload.scope.split(/\s+/).filter(Boolean)
            : previous?.scopes ?? [...this.config.scopes];

        return {
            accessToken: payload.access_token,
            refreshToken: typeof payload.refresh_token === "string"
                ? payload.refresh_token
                : previous?.refreshToken,
            tokenType: typeof payload.token_type === "string"
                ? payload.token_type
                : previous?.tokenType ?? "Bearer",
            scopes,
            expiresAt: new Date(Date.now() + Math.max(1, expiresIn) * 1_000),
        };
    }

    private hasRequiredScopes(tokens: OAuth2TokenSet): boolean {
        const granted = new Set(tokens.scopes);
        return (this.config.accessTokenScopes ?? this.config.scopes)
            .every(scope => granted.has(scope));
    }

    private async loadTokens(signal?: AbortSignal): Promise<OAuth2TokenSet | null> {
        signal?.throwIfAborted();
        if (this.cachedTokens !== undefined) return this.cachedTokens;

        const serialized = await this.secretStore.get(
            this.config.tokenSecretKey,
            { signal },
        );
        if (!serialized) {
            this.cachedTokens = null;
            return null;
        }

        try {
            const parsed: unknown = JSON.parse(serialized);
            if (!isStoredTokenSet(parsed)) throw new TypeError("Invalid token set.");
            const expiresAt = new Date(parsed.expiresAt);
            if (!Number.isFinite(expiresAt.getTime())) throw new TypeError("Invalid expiry.");
            this.cachedTokens = {
                accessToken: parsed.accessToken,
                refreshToken: parsed.refreshToken,
                tokenType: parsed.tokenType,
                scopes: [...parsed.scopes],
                expiresAt,
            };
            return this.cachedTokens;
        } catch (error) {
            throw new OAuth2Error(
                "Os tokens OAuth armazenados estão corrompidos.",
                "reauthentication_required",
                { cause: error },
            );
        }
    }

    private async persistTokens(tokens: OAuth2TokenSet, signal?: AbortSignal): Promise<void> {
        const stored: StoredOAuth2TokenSet = {
            version: 1,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            tokenType: tokens.tokenType,
            scopes: [...tokens.scopes],
            expiresAt: tokens.expiresAt.toISOString(),
        };
        await this.secretStore.set(
            this.config.tokenSecretKey,
            JSON.stringify(stored),
            { signal },
        );
        this.cachedTokens = tokens;
    }
}

interface CallbackOptions {
    readonly expectedPath: string;
    readonly expectedState: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

function waitForAuthorizationCallback(
    server: Server,
    options: CallbackOptions,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            finish(new OAuth2Error("O login OAuth expirou.", "timeout"));
        }, options.timeoutMs);

        const abort = (): void => finish(options.signal?.reason ?? new DOMException(
            "Operação cancelada.",
            "AbortError",
        ));

        const finish = (error?: unknown, code?: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
            server.removeAllListeners("request");
            if (error) reject(error);
            else resolve(code!);
        };

        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) {
            abort();
            return;
        }
        server.on("request", (request, response) => {
            const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
            if (request.method !== "GET" || requestUrl.pathname !== options.expectedPath) {
                response.writeHead(404, securityHeaders()).end("Not found");
                return;
            }

            const returnedState = requestUrl.searchParams.get("state") ?? "";
            if (!constantTimeEqual(returnedState, options.expectedState)) {
                response.writeHead(400, securityHeaders()).end(
                    oauthCallbackPage("Falha de segurança no login. Feche esta janela."),
                );
                finish(new OAuth2Error("Estado OAuth inválido.", "state_mismatch"));
                return;
            }

            if (requestUrl.searchParams.has("error")) {
                response.writeHead(400, securityHeaders()).end(
                    oauthCallbackPage("Autorização recusada. Você pode fechar esta janela."),
                );
                finish(new OAuth2Error("Autorização OAuth recusada.", "authorization_denied"));
                return;
            }

            const code = requestUrl.searchParams.get("code");
            if (!code) {
                response.writeHead(400, securityHeaders()).end(
                    oauthCallbackPage("Código de autorização ausente."),
                );
                finish(new OAuth2Error("Código OAuth ausente.", "authorization_denied"));
                return;
            }

            response.writeHead(200, securityHeaders()).end(
                oauthCallbackPage("Ultron autorizado. Você pode fechar esta janela."),
            );
            finish(undefined, code);
        });
    });
}

function listenOnLoopback(
    server: Server,
    host: "127.0.0.1" | "localhost",
    signal?: AbortSignal,
): Promise<number> {
    signal?.throwIfAborted();
    return new Promise<number>((resolve, reject) => {
        const onAbort = (): void => {
            server.close();
            reject(signal?.reason ?? new DOMException("Operação cancelada.", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        server.once("error", reject);
        server.listen(0, host, () => {
            signal?.removeEventListener("abort", onAbort);
            server.removeListener("error", reject);
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new OAuth2Error("Loopback OAuth indisponível.", "configuration"));
                return;
            }
            resolve(address.port);
        });
    });
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
}

async function openSystemBrowser(url: URL): Promise<void> {
    const command = process.platform === "win32"
        ? { file: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url.toString()] }
        : process.platform === "darwin"
            ? { file: "open", args: [url.toString()] }
            : { file: "xdg-open", args: [url.toString()] };

    await new Promise<void>((resolve, reject) => {
        const child = spawn(command.file, command.args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        child.once("error", error => reject(new OAuth2Error(
            "Não foi possível abrir o navegador para autenticação.",
            "configuration",
            { cause: error },
        )));
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
    });
}

function securityHeaders(): Record<string, string> {
    return {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
    };
}

function oauthCallbackPage(message: string): string {
    return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Ultron OAuth</title><style>body{font:16px system-ui;background:#071016;color:#9be7ef;padding:3rem}</style><body><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    })[character]!);
}

function constantTimeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "utf8");
    const rightBuffer = Buffer.from(right, "utf8");
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function validateOAuthConfig(config: OAuth2DesktopConfig): void {
    if (!config.clientId.trim()) {
        throw new OAuth2Error("OAuth clientId é obrigatório.", "configuration");
    }
    if (config.scopes.length === 0 || config.scopes.some(scope => !scope.trim())) {
        throw new OAuth2Error("Ao menos um scope OAuth é obrigatório.", "configuration");
    }
    if (
        config.accessTokenScopes !== undefined
        && (
            config.accessTokenScopes.length === 0
            || config.accessTokenScopes.some(scope => (
                !scope.trim() || !config.scopes.includes(scope)
            ))
        )
    ) {
        throw new OAuth2Error("Scopes de access token OAuth inválidos.", "configuration");
    }
    if (
        config.redirectHost !== undefined
        && config.redirectHost !== "127.0.0.1"
        && config.redirectHost !== "localhost"
    ) {
        throw new OAuth2Error("Host de loopback OAuth inválido.", "configuration");
    }
    if (!config.tokenSecretKey.trim()) {
        throw new OAuth2Error("Chave segura dos tokens é obrigatória.", "configuration");
    }
    if (
        config.redirectPath !== undefined
        && (!config.redirectPath.startsWith("/")
            || config.redirectPath.startsWith("//")
            || config.redirectPath.includes("?")
            || config.redirectPath.includes("#"))
    ) {
        throw new OAuth2Error("Caminho de loopback OAuth inválido.", "configuration");
    }
    for (const endpoint of [config.authorizationEndpoint, config.tokenEndpoint]) {
        const url = new URL(endpoint);
        if (url.protocol !== "https:") {
            throw new OAuth2Error("Endpoints OAuth devem usar HTTPS.", "configuration");
        }
    }
}

function isStoredTokenSet(value: unknown): value is StoredOAuth2TokenSet {
    if (!value || typeof value !== "object") return false;
    const token = value as Partial<StoredOAuth2TokenSet>;
    return token.version === 1
        && typeof token.accessToken === "string"
        && (token.refreshToken === undefined || typeof token.refreshToken === "string")
        && typeof token.tokenType === "string"
        && Array.isArray(token.scopes)
        && token.scopes.every(scope => typeof scope === "string")
        && typeof token.expiresAt === "string";
}

function authorizationState(
    tokens: OAuth2TokenSet | null,
): OAuth2AuthorizationState {
    if (!tokens) {
        return { authorized: false, scopes: [], canRefresh: false };
    }
    return {
        authorized: true,
        expiresAt: new Date(tokens.expiresAt.getTime()),
        scopes: [...tokens.scopes],
        canRefresh: Boolean(tokens.refreshToken),
    };
}

async function readJsonObject<T extends object>(response: Response): Promise<T> {
    try {
        const value: unknown = await response.json();
        return value && typeof value === "object" ? value as T : {} as T;
    } catch {
        return {} as T;
    }
}
