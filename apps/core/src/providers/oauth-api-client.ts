import { setTimeout as wait } from "node:timers/promises";

import type {
    AccessTokenOptions,
    FetchTransport,
} from "../security/oauth2-desktop.ts";
import { awaitServiceOperation } from "../system/service-lifecycle.ts";
import {
    ProviderAuthenticationError,
    ProviderError,
    ProviderNotFoundError,
    ProviderPermissionError,
} from "./provider.ts";

export interface OAuthApiRequest {
    readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly query?: Readonly<Record<
        string,
        string | number | boolean | readonly string[] | undefined
    >>;
    readonly body?: unknown;
    readonly signal?: AbortSignal;
    readonly headers?: Readonly<Record<string, string>>;
}

export interface AccessTokenSource {
    getAccessToken(options?: AccessTokenOptions): Promise<string>;
}

export interface OAuthApiClientOptions {
    readonly timeoutMs?: number;
    readonly readRetries?: number;
    readonly retryDelayMs?: number;
}

/**
 * Bounded bearer-token JSON client shared by personal providers.
 * Mutations are never retried because a lost response cannot prove that the
 * external side effect did not happen.
 */
export class OAuthApiClient {
    private readonly providerId: string;
    private readonly baseUrl: URL;
    private readonly oauth: AccessTokenSource;
    private readonly transport: FetchTransport;

    constructor(
        providerId: string,
        baseUrl: string,
        oauth: AccessTokenSource,
        transport: FetchTransport = globalThis.fetch,
        private readonly options: OAuthApiClientOptions = {},
    ) {
        this.providerId = providerId;
        this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
        this.oauth = oauth;
        this.transport = transport;
    }

    async request<T>(path: string, request: OAuthApiRequest = {}): Promise<T> {
        request.signal?.throwIfAborted();
        const configured = this.options.timeoutMs
            ?? Number(process.env.ULTRON_PROVIDER_TIMEOUT_MS || 15_000);
        const timeoutMs = Number.isFinite(configured) && configured > 0
            ? Math.min(configured, 60_000)
            : 15_000;
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(new DOMException(
            "O provider excedeu o tempo limite.",
            "TimeoutError",
        )), timeoutMs);
        const signal = request.signal
            ? AbortSignal.any([request.signal, deadline.signal])
            : deadline.signal;
        const configuredRetries = this.options.readRetries ?? 1;
        const retries = (request.method ?? "GET") === "GET"
            ? (Number.isFinite(configuredRetries)
                ? Math.min(2, Math.max(0, Math.floor(configuredRetries)))
                : 1)
            : 0;

        try {
            for (let attempt = 0; ; attempt += 1) {
                signal.throwIfAborted();
                try {
                    return await this.performRequest<T>(path, { ...request, signal }, false);
                } catch (error) {
                    signal.throwIfAborted();
                    if (
                        !(error instanceof ProviderError)
                        || !error.retryable
                        || attempt >= retries
                    ) {
                        throw error;
                    }
                    const delay = Math.max(
                        this.options.retryDelayMs ?? 200,
                        error.retryAfterMs ?? 0,
                    );
                    if (delay > 2_000) throw error;
                    await wait(delay, undefined, { signal });
                }
            }
        } finally {
            clearTimeout(timer);
        }
    }

    private async performRequest<T>(
        path: string,
        request: OAuthApiRequest & { signal: AbortSignal },
        retriedAuthentication: boolean,
    ): Promise<T> {
        let accessToken: string;
        try {
            accessToken = await awaitServiceOperation(this.oauth.getAccessToken({
                signal: request.signal,
                forceRefresh: retriedAuthentication,
            }), request.signal);
        } catch (error) {
            request.signal.throwIfAborted();
            throw new ProviderAuthenticationError(this.providerId, error);
        }
        request.signal.throwIfAborted();

        const url = new URL(path.replace(/^\/+/, ""), this.baseUrl);
        if (
            url.origin !== this.baseUrl.origin
            || !url.pathname.startsWith(this.baseUrl.pathname)
        ) {
            throw new ProviderError("Caminho fora do endpoint permitido do provider.", {
                providerId: this.providerId,
                code: "validation",
            });
        }
        for (const [key, value] of Object.entries(request.query ?? {})) {
            if (Array.isArray(value)) {
                for (const item of value) url.searchParams.append(key, item);
            } else if (value !== undefined) {
                url.searchParams.append(key, String(value));
            }
        }

        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${accessToken}`);
        headers.set("accept", "application/json");
        let body: BodyInit | undefined;
        if (request.body !== undefined) {
            headers.set("content-type", "application/json; charset=utf-8");
            body = JSON.stringify(request.body);
        }

        let response: Response;
        try {
            response = await awaitServiceOperation(this.transport(url, {
                method: request.method ?? "GET",
                headers,
                body,
                signal: request.signal,
            }), request.signal);
        } catch (error) {
            if (request.signal.aborted) throw request.signal.reason;
            throw new ProviderError(`Falha de rede ao acessar ${this.providerId}.`, {
                providerId: this.providerId,
                code: "network",
                retryable: true,
                cause: error,
            });
        }
        request.signal.throwIfAborted();

        if (response.status === 401 && !retriedAuthentication) {
            return await this.performRequest<T>(path, request, true);
        }
        if (!response.ok) throw providerErrorFromResponse(this.providerId, response);
        if (response.status === 204) return undefined as T;
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("json")) return undefined as T;

        try {
            return await awaitServiceOperation(response.json(), request.signal) as T;
        } catch (error) {
            request.signal.throwIfAborted();
            throw new ProviderError(`Resposta inválida recebida de ${this.providerId}.`, {
                providerId: this.providerId,
                code: "remote_error",
                status: response.status,
                cause: error,
            });
        }
    }
}

function providerErrorFromResponse(providerId: string, response: Response): ProviderError {
    switch (response.status) {
        case 401:
            return new ProviderAuthenticationError(providerId);
        case 403:
            return new ProviderPermissionError(providerId);
        case 404:
            return new ProviderNotFoundError(providerId, "Recurso");
        case 409:
            return new ProviderError(`Conflito informado por ${providerId}.`, {
                providerId,
                code: "conflict",
                status: response.status,
            });
        case 429: {
            const header = response.headers.get("retry-after");
            const seconds = header === null ? Number.NaN : Number(header);
            const retryAfterMs = Number.isFinite(seconds)
                ? Math.max(0, seconds * 1_000)
                : header
                    ? Math.max(0, Date.parse(header) - Date.now())
                    : undefined;
            return new ProviderError(`Limite de requisições atingido em ${providerId}.`, {
                providerId,
                code: "rate_limit",
                status: response.status,
                retryable: true,
                retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
            });
        }
        default:
            return new ProviderError(`O provider ${providerId} recusou a operação.`, {
                providerId,
                code: "remote_error",
                status: response.status,
                retryable: response.status >= 500,
            });
    }
}
