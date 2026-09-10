import {
    OAuth2DesktopClient,
    type FetchTransport,
} from "../../security/oauth2-desktop.ts";
import type { SecretStore } from "../../security/secret-store.ts";

export const MICROSOFT_PROVIDER_SCOPES = {
    offlineAccess: "offline_access",
    tasks: "Tasks.ReadWrite",
    calendar: "Calendars.ReadWrite",
} as const;

export interface MicrosoftOAuthClientOptions {
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly tenant?: string;
    readonly scopes: readonly string[];
    readonly tokenSecretKey?: string;
    readonly transport?: FetchTransport;
}

/** Microsoft identity platform v2 desktop flow with PKCE and loopback. */
export function createMicrosoftOAuthClient(
    options: MicrosoftOAuthClientOptions,
    secretStore: SecretStore,
): OAuth2DesktopClient {
    const tenant = checkedTenant(options.tenant ?? "common");
    const identityBase = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
    const accessTokenScopes = options.scopes.filter(scope => (
        scope !== "offline_access"
        && scope !== "openid"
        && scope !== "profile"
    ));

    return new OAuth2DesktopClient({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        authorizationEndpoint: `${identityBase}/authorize`,
        tokenEndpoint: `${identityBase}/token`,
        scopes: options.scopes,
        accessTokenScopes,
        tokenSecretKey: options.tokenSecretKey ?? "microsoft.oauth.tokens",
        redirectHost: "localhost",
        redirectPath: "/oauth2/microsoft/callback",
        additionalAuthorizationParameters: {
            response_mode: "query",
        },
    }, secretStore, options.transport);
}

function checkedTenant(value: string): string {
    const tenant = value.trim();
    if (
        !tenant
        || tenant.length > 255
        || !/^[a-zA-Z0-9.-]+$/.test(tenant)
        || tenant.includes("..")
    ) {
        throw new TypeError("Tenant Microsoft inválido.");
    }
    return tenant;
}
