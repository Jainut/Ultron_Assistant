import type {
    AccessTokenOptions,
    FetchTransport,
} from "../../security/oauth2-desktop.ts";
import {
    ProviderAuthenticationError,
    ProviderError,
    ProviderNotFoundError,
    ProviderPermissionError,
} from "../provider.ts";

export interface GoogleApiRequest {
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

export class GoogleApiClient {
    private readonly providerId: string;
    private readonly baseUrl: URL;
    private readonly oauth: AccessTokenSource;
    private readonly transport: FetchTransport;

    constructor(
        providerId: string,
        baseUrl: string,
        oauth: AccessTokenSource,
        transport: FetchTransport = globalThis.fetch,
    ) {
        this.providerId = providerId;
        this.baseUrl = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
        this.oauth = oauth;
        this.transport = transport;
    }

    async request<T>(path: string, request: GoogleApiRequest = {}): Promise<T> {
        request.signal?.throwIfAborted();
        return await this.performRequest<T>(path, request, false);
    }

    private async performRequest<T>(
        path: string,
        request: GoogleApiRequest,
        retriedAuthentication: boolean,
    ): Promise<T> {
        const tokenOptions: AccessTokenOptions = {
            signal: request.signal,
            forceRefresh: retriedAuthentication,
        };
        let accessToken: string;
        try {
            accessToken = await this.oauth.getAccessToken(tokenOptions);
        } catch (error) {
            throw new ProviderAuthenticationError(this.providerId, error);
        }

        const url = new URL(path.replace(/^\/+/, ""), this.baseUrl);
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
            response = await this.transport(url, {
                method: request.method ?? "GET",
                headers,
                body,
                signal: request.signal,
            });
        } catch (error) {
            if (request.signal?.aborted) throw request.signal.reason;
            throw new ProviderError(`Falha de rede ao acessar ${this.providerId}.`, {
                providerId: this.providerId,
                code: "network",
                retryable: true,
                cause: error,
            });
        }

        if (response.status === 401 && !retriedAuthentication) {
            return await this.performRequest<T>(path, request, true);
        }

        if (!response.ok) {
            throw providerErrorFromResponse(this.providerId, response);
        }

        if (response.status === 204) return undefined as T;
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("json")) return undefined as T;

        try {
            return await response.json() as T;
        } catch (error) {
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
            const retryAfter = Number(response.headers.get("retry-after"));
            return new ProviderError(`Limite de requisições atingido em ${providerId}.`, {
                providerId,
                code: "rate_limit",
                status: response.status,
                retryable: true,
                retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1_000 : undefined,
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
