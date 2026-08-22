import {
    OAuth2DesktopClient,
    type FetchTransport,
} from "../../security/oauth2-desktop.ts";
import type { SecretStore } from "../../security/secret-store.ts";

export const GOOGLE_OAUTH_ENDPOINTS = {
    authorization: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
} as const;

export const GOOGLE_PROVIDER_SCOPES = {
    gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
    gmailModify: "https://www.googleapis.com/auth/gmail.modify",
    gmailCompose: "https://www.googleapis.com/auth/gmail.compose",
    gmailSend: "https://www.googleapis.com/auth/gmail.send",
    tasks: "https://www.googleapis.com/auth/tasks",
    calendar: "https://www.googleapis.com/auth/calendar",
} as const;

export interface GoogleOAuthClientOptions {
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly scopes: readonly string[];
    readonly tokenSecretKey?: string;
    readonly transport?: FetchTransport;
}

export function createGoogleOAuthClient(
    options: GoogleOAuthClientOptions,
    secretStore: SecretStore,
): OAuth2DesktopClient {
    return new OAuth2DesktopClient({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        authorizationEndpoint: GOOGLE_OAUTH_ENDPOINTS.authorization,
        tokenEndpoint: GOOGLE_OAUTH_ENDPOINTS.token,
        scopes: options.scopes,
        tokenSecretKey: options.tokenSecretKey ?? "google.oauth.tokens",
        additionalAuthorizationParameters: {
            access_type: "offline",
            include_granted_scopes: "true",
            prompt: "consent",
        },
    }, secretStore, options.transport);
}
