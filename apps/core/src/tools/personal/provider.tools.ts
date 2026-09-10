import type { OAuth2AuthorizationState } from "../../security/oauth2-desktop.ts";
import type { PersonalProviderRuntime } from "../../providers/personal-provider-runtime.ts";
import type { ToolDefinition } from "../tool.ts";
import { providerUnavailable } from "./personal-tool-helpers.ts";

/**
 * Explicit interactive entry point. Merely importing, creating, or registering
 * this tool cannot start OAuth; only execute() invokes connectGoogle().
 */
export function createGoogleConnectTool(
    runtime: PersonalProviderRuntime,
): ToolDefinition<Record<string, never>, OAuth2AuthorizationState> {
    return {
        name: "google.connect",
        aliases: ["provider.connect", "connect_google"],
        description: "Conecta explicitamente Gmail, Google Tasks e Google Calendar via OAuth.",
        category: "automation",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
        capabilities: ["provider.connect.google"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "confirmed",
        responsePolicy: {
            deterministic: true,
            format: result => result.success
                ? "Conta Google conectada."
                : result.message,
        },
        async execute(_input, toolContext) {
            if (!(runtime.googleConfigured ?? runtime.configured)) {
                return providerUnavailable(runtime, "Integração Google");
            }
            const state = await runtime.connectGoogle(toolContext.signal);
            if (!state.authorized) {
                return {
                    success: false,
                    status: "failed",
                    message: "A autorização da conta Google não foi concluída.",
                    speech: "A conexão com a conta Google não foi concluída.",
                    data: state,
                    error: {
                        code: "GOOGLE_AUTHORIZATION_INCOMPLETE",
                        message: "OAuth retornou estado não autorizado.",
                        retryable: true,
                    },
                };
            }
            return {
                success: true,
                status: "confirmed",
                message: "Conta Google conectada com segurança.",
                speech: "Conta Google conectada.",
                data: state,
            };
        },
    };
}

/** Explicit Microsoft 365 OAuth entry point. Registration remains side-effect free. */
export function createMicrosoftConnectTool(
    runtime: PersonalProviderRuntime,
): ToolDefinition<Record<string, never>, OAuth2AuthorizationState> {
    return {
        name: "microsoft.connect",
        aliases: ["connect_microsoft", "provider.connect.microsoft"],
        description: "Conecta explicitamente Microsoft To Do e Outlook Calendar via OAuth.",
        category: "automation",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
        capabilities: ["provider.connect.microsoft"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "confirmed",
        responsePolicy: {
            deterministic: true,
            format: result => result.success
                ? "Conta Microsoft conectada."
                : result.message,
        },
        async execute(_input, toolContext) {
            if (!runtime.microsoftConfigured || !runtime.connectMicrosoft) {
                return providerUnavailable(runtime, "Integração Microsoft 365");
            }
            const state = await runtime.connectMicrosoft(toolContext.signal);
            if (!state.authorized) {
                return {
                    success: false,
                    status: "failed",
                    message: "A autorização da conta Microsoft não foi concluída.",
                    speech: "A conexão com a conta Microsoft não foi concluída.",
                    data: state,
                    error: {
                        code: "MICROSOFT_AUTHORIZATION_INCOMPLETE",
                        message: "OAuth retornou estado não autorizado.",
                        retryable: true,
                    },
                };
            }
            return {
                success: true,
                status: "confirmed",
                message: "Conta Microsoft conectada com segurança.",
                speech: "Conta Microsoft conectada.",
                data: state,
            };
        },
    };
}
