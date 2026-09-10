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
import {
    MicrosoftCalendarProvider,
    MicrosoftTodoProvider,
    createMicrosoftOAuthClient,
    MICROSOFT_PROVIDER_SCOPES,
} from "./microsoft/index.ts";
import { ProviderManager } from "./provider-manager.ts";
import type { TaskProvider } from "./task-provider.ts";

export type PersonalProviderChoice = "google" | "microsoft";

export interface PersonalProviderRuntime {
    readonly configured: boolean;
    readonly googleConfigured?: boolean;
    readonly microsoftConfigured?: boolean;
    readonly configurationMessage?: string;
    readonly mail?: MailProvider;
    readonly tasks?: TaskProvider;
    readonly calendar?: CalendarProvider;
    readonly manager?: ProviderManager;
    readonly selections?: Readonly<{
        mail?: PersonalProviderChoice;
        tasks?: PersonalProviderChoice;
        calendar?: PersonalProviderChoice;
    }>;

    /**
     * This is the only interactive OAuth entry point. Building or registering
     * the runtime never opens a browser and never starts an authorization flow.
     */
    connectGoogle(signal?: AbortSignal): Promise<OAuth2AuthorizationState>;
    connectMicrosoft?(signal?: AbortSignal): Promise<OAuth2AuthorizationState>;
}

export interface PersonalProviderRuntimeOptions {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly secretStore?: SecretStore;
    readonly transport?: FetchTransport;
    readonly openAuthorizationUrl?: (url: URL) => Promise<void> | void;
    readonly openMicrosoftAuthorizationUrl?: (url: URL) => Promise<void> | void;
}

/** @deprecated Use PersonalProviderRuntimeOptions. Kept for source compatibility. */
export type GooglePersonalProviderRuntimeOptions = PersonalProviderRuntimeOptions;

export interface GooglePersonalProviderRuntime extends PersonalProviderRuntime {
    readonly configured: true;
    readonly mail: MailProvider;
    readonly tasks: TaskProvider;
    readonly calendar: CalendarProvider;
    readonly manager: ProviderManager;
}

/**
 * Creates a provider composition from environment configuration. This
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
 * - ULTRON_MICROSOFT_CLIENT_ID
 * - ULTRON_MICROSOFT_CLIENT_SECRET
 * - ULTRON_MICROSOFT_TENANT (defaults to common)
 * - ULTRON_MICROSOFT_SCOPES
 * - ULTRON_MICROSOFT_TIME_ZONE
 * - ULTRON_MICROSOFT_TOKEN_SECRET_KEY
 * - ULTRON_MICROSOFT_TASK_LIST_ID
 * - ULTRON_MICROSOFT_CALENDAR_ID
 * - ULTRON_TASK_PROVIDER / ULTRON_CALENDAR_PROVIDER (google|microsoft)
 */
export function createPersonalProviderRuntimeFromEnv(
    options: PersonalProviderRuntimeOptions = {},
): PersonalProviderRuntime {
    const environment = options.environment ?? process.env;
    const googleClientId = environment.ULTRON_GOOGLE_CLIENT_ID?.trim();
    const microsoftClientId = environment.ULTRON_MICROSOFT_CLIENT_ID?.trim();
    const taskChoice = providerChoice(
        environment.ULTRON_TASK_PROVIDER,
        Boolean(googleClientId),
        Boolean(microsoftClientId),
    );
    const calendarChoice = providerChoice(
        environment.ULTRON_CALENDAR_PROVIDER,
        Boolean(googleClientId),
        Boolean(microsoftClientId),
    );
    let secretStore = options.secretStore;
    const getSecretStore = (): SecretStore => (
        secretStore ??= createDefaultSecretStore()
    );
    const manager = new ProviderManager();
    let mail: MailProvider | undefined;
    let tasks: TaskProvider | undefined;
    let calendar: CalendarProvider | undefined;
    let googleOAuth: ReturnType<typeof createGoogleOAuthClient> | undefined;
    let microsoftOAuth: ReturnType<typeof createMicrosoftOAuthClient> | undefined;

    if (googleClientId) {
        const timeZone = environment.ULTRON_GOOGLE_TIME_ZONE?.trim()
            || "America/Sao_Paulo";
        const configuredScopes = splitScopes(environment.ULTRON_GOOGLE_SCOPES);
        const scopes = configuredScopes.length > 0
            ? configuredScopes
            : [
                GOOGLE_PROVIDER_SCOPES.gmailModify,
                ...(taskChoice === "google" ? [GOOGLE_PROVIDER_SCOPES.tasks] : []),
                ...(calendarChoice === "google" ? [GOOGLE_PROVIDER_SCOPES.calendar] : []),
            ];
        googleOAuth = createGoogleOAuthClient({
            clientId: googleClientId,
            clientSecret: environment.ULTRON_GOOGLE_CLIENT_SECRET?.trim() || undefined,
            scopes,
            tokenSecretKey: environment.ULTRON_GOOGLE_TOKEN_SECRET_KEY?.trim()
                || "google.oauth.tokens",
            transport: options.transport,
        }, getSecretStore());
        mail = new GmailProvider({
            oauth: googleOAuth,
            transport: options.transport,
            userId: environment.ULTRON_GOOGLE_GMAIL_USER_ID?.trim() || undefined,
            timeZone,
        });
        manager.register(mail);
        if (taskChoice === "google") {
            tasks = new GoogleTasksProvider({
                oauth: googleOAuth,
                transport: options.transport,
                defaultTaskListId: environment.ULTRON_GOOGLE_TASK_LIST_ID?.trim() || undefined,
                timeZone,
            });
            manager.register(tasks);
        }
        if (calendarChoice === "google") {
            calendar = new GoogleCalendarProvider({
                oauth: googleOAuth,
                transport: options.transport,
                defaultCalendarId: environment.ULTRON_GOOGLE_CALENDAR_ID?.trim() || undefined,
                timeZone,
            });
            manager.register(calendar);
        }
    }

    const microsoftActive = taskChoice === "microsoft" || calendarChoice === "microsoft";
    if (microsoftClientId && microsoftActive) {
        const timeZone = environment.ULTRON_MICROSOFT_TIME_ZONE?.trim()
            || "America/Sao_Paulo";
        const configuredScopes = splitScopes(environment.ULTRON_MICROSOFT_SCOPES);
        const scopes = [...new Set([
            MICROSOFT_PROVIDER_SCOPES.offlineAccess,
            ...(taskChoice === "microsoft" ? [MICROSOFT_PROVIDER_SCOPES.tasks] : []),
            ...(calendarChoice === "microsoft" ? [MICROSOFT_PROVIDER_SCOPES.calendar] : []),
            ...configuredScopes,
        ])];
        microsoftOAuth = createMicrosoftOAuthClient({
            clientId: microsoftClientId,
            clientSecret: environment.ULTRON_MICROSOFT_CLIENT_SECRET?.trim() || undefined,
            tenant: environment.ULTRON_MICROSOFT_TENANT?.trim() || "common",
            scopes,
            tokenSecretKey: environment.ULTRON_MICROSOFT_TOKEN_SECRET_KEY?.trim()
                || "microsoft.oauth.tokens",
            transport: options.transport,
        }, getSecretStore());
        if (taskChoice === "microsoft") {
            tasks = new MicrosoftTodoProvider({
                oauth: microsoftOAuth,
                transport: options.transport,
                defaultTaskListId: environment.ULTRON_MICROSOFT_TASK_LIST_ID?.trim() || undefined,
                timeZone,
            });
            manager.register(tasks);
        }
        if (calendarChoice === "microsoft") {
            calendar = new MicrosoftCalendarProvider({
                oauth: microsoftOAuth,
                transport: options.transport,
                defaultCalendarId: environment.ULTRON_MICROSOFT_CALENDAR_ID?.trim() || undefined,
                timeZone,
            });
            manager.register(calendar);
        }
    }

    const configured = Boolean(mail || tasks || calendar);
    const configurationMessage = providerConfigurationMessage(
        environment,
        googleClientId,
        microsoftClientId,
    );
    return {
        configured,
        googleConfigured: Boolean(googleOAuth),
        microsoftConfigured: Boolean(microsoftOAuth),
        ...(configurationMessage ? { configurationMessage } : {}),
        ...(mail ? { mail } : {}),
        ...(tasks ? { tasks } : {}),
        ...(calendar ? { calendar } : {}),
        manager,
        selections: {
            ...(mail ? { mail: "google" as const } : {}),
            ...(tasks && taskChoice ? { tasks: taskChoice } : {}),
            ...(calendar && calendarChoice ? { calendar: calendarChoice } : {}),
        },
        async connectGoogle(signal?: AbortSignal): Promise<OAuth2AuthorizationState> {
            signal?.throwIfAborted();
            if (!googleOAuth) {
                throw new Error("Configure ULTRON_GOOGLE_CLIENT_ID para conectar a conta Google.");
            }
            return await googleOAuth.authorizeInteractive({
                signal,
                openAuthorizationUrl: options.openAuthorizationUrl,
            });
        },
        async connectMicrosoft(signal?: AbortSignal): Promise<OAuth2AuthorizationState> {
            signal?.throwIfAborted();
            if (!microsoftOAuth) {
                throw new Error(
                    "Configure ULTRON_MICROSOFT_CLIENT_ID e selecione Microsoft para To Do ou Calendar.",
                );
            }
            return await microsoftOAuth.authorizeInteractive({
                signal,
                openAuthorizationUrl: options.openMicrosoftAuthorizationUrl
                    ?? options.openAuthorizationUrl,
            });
        },
    };
}

function providerChoice(
    configured: string | undefined,
    googleAvailable: boolean,
    microsoftAvailable: boolean,
): PersonalProviderChoice | undefined {
    const requested = configured?.trim().toLocaleLowerCase("en-US");
    if (requested === "google") return googleAvailable ? "google" : undefined;
    if (requested === "microsoft") return microsoftAvailable ? "microsoft" : undefined;
    if (requested) return undefined;
    if (microsoftAvailable) return "microsoft";
    if (googleAvailable) return "google";
    return undefined;
}

function splitScopes(value: string | undefined): string[] {
    return value?.split(/[,;\s]+/).map(scope => scope.trim()).filter(Boolean) ?? [];
}

function providerConfigurationMessage(
    environment: Readonly<Record<string, string | undefined>>,
    googleClientId: string | undefined,
    microsoftClientId: string | undefined,
): string | undefined {
    if (
        environment.ULTRON_TASK_PROVIDER?.trim()
        && !["google", "microsoft"].includes(
            environment.ULTRON_TASK_PROVIDER.trim().toLocaleLowerCase("en-US"),
        )
    ) {
        return "ULTRON_TASK_PROVIDER deve ser google ou microsoft.";
    }
    if (
        environment.ULTRON_CALENDAR_PROVIDER?.trim()
        && !["google", "microsoft"].includes(
            environment.ULTRON_CALENDAR_PROVIDER.trim().toLocaleLowerCase("en-US"),
        )
    ) {
        return "ULTRON_CALENDAR_PROVIDER deve ser google ou microsoft.";
    }
    if (!googleClientId && !microsoftClientId) {
        return "Configure ULTRON_GOOGLE_CLIENT_ID ou ULTRON_MICROSOFT_CLIENT_ID para conectar serviços pessoais.";
    }
    const taskProvider = environment.ULTRON_TASK_PROVIDER?.trim().toLocaleLowerCase("en-US");
    const calendarProvider = environment.ULTRON_CALENDAR_PROVIDER?.trim().toLocaleLowerCase("en-US");
    if (
        (taskProvider === "google" || calendarProvider === "google")
        && !googleClientId
    ) {
        return "O provider Google selecionado não possui ULTRON_GOOGLE_CLIENT_ID configurado.";
    }
    if (
        (taskProvider === "microsoft" || calendarProvider === "microsoft")
        && !microsoftClientId
    ) {
        return "O provider Microsoft selecionado não possui ULTRON_MICROSOFT_CLIENT_ID configurado.";
    }
    return undefined;
}
