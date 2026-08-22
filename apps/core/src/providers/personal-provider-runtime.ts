import type { FetchTransport, OAuth2AuthorizationState } from "../security/oauth2-desktop.ts";
import {
    createDefaultSecretStore,
    type SecretStore,
} from "../security/secret-store.ts";
import type { CalendarProvider } from "./calendar-provider.ts";
import {
    GmailProvider,
    GoogleCalendarProvider,
    GoogleTasksProvider,
    createGoogleOAuthClient,
    GOOGLE_PROVIDER_SCOPES,
} from "./google/index.ts";
import type { MailProvider } from "./mail-provider.ts";
import { ProviderManager } from "./provider-manager.ts";
import type { TaskProvider } from "./task-provider.ts";

export interface PersonalProviderRuntime {
    readonly configured: boolean;
    readonly configurationMessage?: string;
    readonly mail?: MailProvider;
    readonly tasks?: TaskProvider;
    readonly calendar?: CalendarProvider;

    /**
     * This is the only interactive OAuth entry point. Building or registering
     * the runtime never opens a browser and never starts an authorization flow.
     */
    connectGoogle(signal?: AbortSignal): Promise<OAuth2AuthorizationState>;
}

export interface GooglePersonalProviderRuntimeOptions {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly secretStore?: SecretStore;
    readonly transport?: FetchTransport;
    readonly openAuthorizationUrl?: (url: URL) => Promise<void> | void;
}

export interface GooglePersonalProviderRuntime extends PersonalProviderRuntime {
    readonly configured: true;
    readonly mail: MailProvider;
    readonly tasks: TaskProvider;
    readonly calendar: CalendarProvider;
    readonly manager: ProviderManager;
}

const DEFAULT_GOOGLE_SCOPES = [
    GOOGLE_PROVIDER_SCOPES.gmailModify,
    GOOGLE_PROVIDER_SCOPES.tasks,
    GOOGLE_PROVIDER_SCOPES.calendar,
] as const;

/**
 * Creates the Google provider set from environment configuration. This
 * function is deliberately side-effect free with respect to OAuth: it creates
 * clients, but does not read tokens, perform network requests, or open a URL.
 *
 * Supported variables:
 * - ULTRON_GOOGLE_CLIENT_ID (required)
 * - ULTRON_GOOGLE_CLIENT_SECRET (optional for a desktop PKCE client)
 * - ULTRON_GOOGLE_SCOPES (optional comma/semicolon-separated override)
 * - ULTRON_GOOGLE_TIME_ZONE (defaults to America/Sao_Paulo)
 * - ULTRON_GOOGLE_TOKEN_SECRET_KEY
 * - ULTRON_GOOGLE_GMAIL_USER_ID
 * - ULTRON_GOOGLE_TASK_LIST_ID
 * - ULTRON_GOOGLE_CALENDAR_ID
 */
export function createPersonalProviderRuntimeFromEnv(
    options: GooglePersonalProviderRuntimeOptions = {},
): PersonalProviderRuntime {
    const environment = options.environment ?? process.env;
    const clientId = environment.ULTRON_GOOGLE_CLIENT_ID?.trim();

    if (!clientId) {
        const configurationMessage =
            "Configure ULTRON_GOOGLE_CLIENT_ID para conectar Gmail, Google Tasks e Google Calendar.";
        return {
            configured: false,
            configurationMessage,
            async connectGoogle(signal?: AbortSignal): Promise<OAuth2AuthorizationState> {
                signal?.throwIfAborted();
                throw new Error(configurationMessage);
            },
        };
    }

    const timeZone = environment.ULTRON_GOOGLE_TIME_ZONE?.trim()
        || "America/Sao_Paulo";
    const secretStore = options.secretStore ?? createDefaultSecretStore();
    const configuredScopes = environment.ULTRON_GOOGLE_SCOPES
        ?.split(/[,;\s]+/)
        .map(value => value.trim())
        .filter(Boolean)
        ?? [];
    const scopes = configuredScopes.length > 0
        ? configuredScopes
        : [...DEFAULT_GOOGLE_SCOPES];
    const oauth = createGoogleOAuthClient({
        clientId,
        clientSecret: environment.ULTRON_GOOGLE_CLIENT_SECRET?.trim() || undefined,
        scopes,
        tokenSecretKey: environment.ULTRON_GOOGLE_TOKEN_SECRET_KEY?.trim()
            || "google.oauth.tokens",
        transport: options.transport,
    }, secretStore);

    const mail = new GmailProvider({
        oauth,
        transport: options.transport,
        userId: environment.ULTRON_GOOGLE_GMAIL_USER_ID?.trim() || undefined,
        timeZone,
    });
    const tasks = new GoogleTasksProvider({
        oauth,
        transport: options.transport,
        defaultTaskListId: environment.ULTRON_GOOGLE_TASK_LIST_ID?.trim() || undefined,
        timeZone,
    });
    const calendar = new GoogleCalendarProvider({
        oauth,
        transport: options.transport,
        defaultCalendarId: environment.ULTRON_GOOGLE_CALENDAR_ID?.trim() || undefined,
        timeZone,
    });
    const manager = new ProviderManager()
        .register(mail)
        .register(tasks)
        .register(calendar);

    const runtime: GooglePersonalProviderRuntime = {
        configured: true,
        mail,
        tasks,
        calendar,
        manager,
        async connectGoogle(signal?: AbortSignal): Promise<OAuth2AuthorizationState> {
            signal?.throwIfAborted();
            return await oauth.authorizeInteractive({
                signal,
                openAuthorizationUrl: options.openAuthorizationUrl,
            });
        },
    };
    return runtime;
}
