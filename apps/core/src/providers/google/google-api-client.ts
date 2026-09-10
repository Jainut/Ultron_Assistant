import type { FetchTransport } from "../../security/oauth2-desktop.ts";
import {
    OAuthApiClient,
    type AccessTokenSource,
    type OAuthApiClientOptions,
    type OAuthApiRequest,
} from "../oauth-api-client.ts";

export type GoogleApiRequest = OAuthApiRequest;
export type GoogleApiClientOptions = OAuthApiClientOptions;
export type { AccessTokenSource };

/** Backward-compatible Google facade over the shared bearer JSON client. */
export class GoogleApiClient extends OAuthApiClient {
    constructor(
        providerId: string,
        baseUrl: string,
        oauth: AccessTokenSource,
        transport: FetchTransport = globalThis.fetch,
        options: GoogleApiClientOptions = {},
    ) {
        super(providerId, baseUrl, oauth, transport, options);
    }
}
