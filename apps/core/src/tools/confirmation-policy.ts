import type { ToolResult } from "../../shared/types.ts";
import type { ToolContext, ToolDefinition } from "./tool.ts";

export interface ConfirmationDecision {
    allowed: boolean;
    result?: ToolResult;
}

/**
 * Centraliza autorização de ações sensíveis. Providers e tools não devem
 * espalhar verificações próprias de confirmação pelo código.
 */
export class ConfirmationPolicy {
    evaluate(
        tool: ToolDefinition<unknown, unknown>,
        context: ToolContext,
    ): ConfirmationDecision {
        const grant = context.capabilityGrant;
        const denied = new Set(grant?.denied ?? []);
        const allowed = grant?.allowed ? new Set(grant.allowed) : null;
        const deniedCapability = tool.capabilities.find(capability => (
            denied.has(capability)
            || (allowed !== null && !allowed.has(capability))
        ));

        if (deniedCapability) {
            const message = `A capability ${deniedCapability} não está autorizada neste contexto.`;
            return {
                allowed: false,
                result: {
                    success: false,
                    status: "failed",
                    message,
                    speech: message,
                    error: {
                        code: "CAPABILITY_DENIED",
                        message,
                        retryable: false,
                    },
                },
            };
        }

        if (tool.confirmationLevel === "none") {
            return { allowed: true };
        }

        const approval = context.confirmation;
        const allowedCapabilities = tool.capabilities.length > 0
            ? tool.capabilities
            : [tool.name];
        const capabilityAllowed = typeof approval?.capability === "string"
            && allowedCapabilities.includes(approval.capability);
        const hasConfirmationId = typeof approval?.confirmationId === "string"
            && approval.confirmationId.length > 0;

        if (approval?.approved && capabilityAllowed && hasConfirmationId) {
            return { allowed: true };
        }

        const capability = tool.capabilities[0] ?? tool.name;
        const message = tool.confirmationLevel === "dangerous"
            ? `A ação ${tool.name} pode causar perda de dados e exige confirmação explícita.`
            : `Confirme a ação ${tool.name} antes de continuar.`;

        return {
            allowed: false,
            result: {
                success: false,
                status: "unknown",
                message,
                speech: message,
                data: {
                    confirmationRequired: true,
                    confirmationLevel: tool.confirmationLevel,
                    capability,
                },
            },
        };
    }
}

export const confirmationPolicy = new ConfirmationPolicy();
