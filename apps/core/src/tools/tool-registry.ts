import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ToolResult } from "../../shared/types.ts";
import { confirmationPolicy, type ConfirmationPolicy } from "./confirmation-policy.ts";
import type {
    ToolCategory,
    ToolContext,
    ToolDefinition,
} from "./tool.ts";
import { validateToolInput } from "./json-schema-validator.ts";
import { requestPerformanceTimelines } from "../utils/request-performance-timeline.ts";

type RegisteredTool = ToolDefinition<unknown, unknown>;

interface ActiveToolApproval {
    readonly pending: PendingToolConfirmation;
    consumed: boolean;
}

export interface ModelToolSchema {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface ToolSelection {
    names?: readonly string[];
    categories?: readonly ToolCategory[];
}

export interface PendingToolConfirmation {
    readonly confirmationId: string;
    readonly conversationId: string;
    readonly toolName: string;
    readonly input: unknown;
    readonly capability: string;
    readonly expiresAt: number;
}

export interface PendingConfirmationExecution {
    readonly name: string;
    readonly result: ToolResult;
    readonly remainingConfirmations?: number;
}

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

export class ToolRegistry {
    private readonly tools = new Map<string, RegisteredTool>();
    private readonly aliases = new Map<string, string>();
    private readonly pendingConfirmations = new Map<
        string,
        Map<string, PendingToolConfirmation>
    >();
    /** Aprovações em voo só podem ser criadas por approvePendingConfirmation(). */
    private readonly activeApprovals = new Map<string, ActiveToolApproval>();
    private readonly confirmationTtlMs = 5 * 60_000;

    constructor(
        private readonly policy: ConfirmationPolicy = confirmationPolicy,
    ) {}

    register<TInput, TData>(tool: ToolDefinition<TInput, TData>): this {
        const key = normalizeName(tool.name);

        if (this.tools.has(key)) {
            throw new Error(`Ferramenta já registrada: ${tool.name}`);
        }

        this.tools.set(key, tool as RegisteredTool);
        this.aliases.set(key, key);

        for (const alias of tool.aliases ?? []) {
            const normalizedAlias = normalizeName(alias);
            const owner = this.aliases.get(normalizedAlias);

            if (owner && owner !== key) {
                throw new Error(
                    `Alias de ferramenta duplicado: ${alias} (${owner} e ${key})`,
                );
            }

            this.aliases.set(normalizedAlias, key);
        }

        return this;
    }

    has(name: string): boolean {
        return this.resolveName(name) !== null;
    }

    get(name: string): RegisteredTool | null {
        const resolved = this.resolveName(name);
        return resolved ? this.tools.get(resolved) ?? null : null;
    }

    async execute<TData = unknown>(
        name: string,
        input: unknown,
        context: ToolContext = {},
    ): Promise<ToolResult<TData>> {
        const timeline = context.requestId
            ? requestPerformanceTimelines.get(context.requestId)
            : undefined;
        timeline?.mark("tool_start", { toolCallId: context.toolCallId });

        try {
            context.signal?.throwIfAborted();
            const tool = this.get(name);

            if (!tool) {
                return {
                    success: false,
                    status: "failed",
                    message: `Ferramenta desconhecida: ${name}`,
                    error: {
                        code: "TOOL_NOT_FOUND",
                        message: `Ferramenta desconhecida: ${name}`,
                        retryable: false,
                    },
                };
            }

            const validation = validateToolInput(tool.inputSchema, input);
            if (!validation.valid) {
                const message = `Entrada inválida para ${tool.name}: ${validation.errors.join(" ")}`;
                return {
                    success: false,
                    status: "failed",
                    message,
                    error: {
                        code: "TOOL_INPUT_INVALID",
                        message,
                        retryable: false,
                    },
                };
            }

            const invalidApproval = this.validateActiveApproval(tool, input, context);
            if (invalidApproval) return invalidApproval as ToolResult<TData>;

            const decision = this.policy.evaluate(tool, context);

            if (!decision.allowed) {
                const blocked = decision.result as ToolResult<TData>;
                if (
                    context.conversationId
                    && blocked.data
                    && typeof blocked.data === "object"
                    && "confirmationRequired" in blocked.data
                ) {
                    const confirmationId = randomUUID();
                    const capability = tool.capabilities[0] ?? tool.name;
                    const pending: PendingToolConfirmation = {
                        confirmationId,
                        conversationId: context.conversationId,
                        toolName: tool.name,
                        input: structuredClone(input),
                        capability,
                        expiresAt: Date.now() + this.confirmationTtlMs,
                    };
                    this.pendingQueue(context.conversationId, true)!
                        .set(confirmationId, pending);
                    return {
                        ...blocked,
                        data: {
                            ...(blocked.data as Record<string, unknown>),
                            confirmationId,
                        },
                    } as ToolResult<TData>;
                }
                return blocked;
            }

            try {
                const result = await tool.execute(input, context);
                const status = result.status
                    ?? (result.success ? tool.successStatus ?? "confirmed" : "failed");

                return {
                    ...result,
                    status,
                } as ToolResult<TData>;
            } catch (error) {
                if (context.signal?.aborted) {
                    throw error;
                }

                const message = error instanceof Error ? error.message : String(error);
                return {
                    success: false,
                    status: "failed",
                    message,
                    speech: message,
                    error: {
                        code: "TOOL_EXECUTION_FAILED",
                        message,
                        retryable: true,
                    },
                };
            }
        } finally {
            timeline?.mark("tool_end", { toolCallId: context.toolCallId });
        }
    }

    pendingConfirmation(conversationId: string): PendingToolConfirmation | null {
        const pending = this.pendingQueue(conversationId)?.values().next().value as
            PendingToolConfirmation | undefined;
        if (!pending) return null;
        return { ...pending, input: structuredClone(pending.input) };
    }

    pendingConfirmationsForConversation(
        conversationId: string,
    ): readonly PendingToolConfirmation[] {
        return [...(this.pendingQueue(conversationId)?.values() ?? [])].map(
            pending => ({ ...pending, input: structuredClone(pending.input) }),
        );
    }

    cancelPendingConfirmation(
        conversationId: string,
        confirmationId?: string,
    ): PendingConfirmationExecution | null {
        const pending = this.takePendingConfirmation(conversationId, confirmationId);
        if (!pending) return null;
        return {
            name: pending.toolName,
            remainingConfirmations: this.pendingQueue(conversationId)?.size ?? 0,
            result: {
                success: true,
                status: "confirmed",
                message: "Ação cancelada.",
                speech: "Certo, ação cancelada.",
                data: { confirmationId: pending.confirmationId, cancelled: true },
            },
        };
    }

    async approvePendingConfirmation(
        conversationId: string,
        context: ToolContext = {},
        confirmationId?: string,
    ): Promise<PendingConfirmationExecution | null> {
        const pending = this.takePendingConfirmation(conversationId, confirmationId);
        if (!pending) return null;
        this.activeApprovals.set(pending.confirmationId, {
            pending,
            consumed: false,
        });
        try {
            const result = await this.execute(pending.toolName, pending.input, {
                ...context,
                conversationId,
                confirmation: {
                    approved: true,
                    capability: pending.capability,
                    confirmationId: pending.confirmationId,
                },
            });
            return {
                name: pending.toolName,
                result,
                remainingConfirmations: this.pendingQueue(conversationId)?.size ?? 0,
            };
        } finally {
            this.activeApprovals.delete(pending.confirmationId);
        }
    }

    formatResponse(name: string, result: ToolResult): string {
        if (
            result.data
            && typeof result.data === "object"
            && "cancelled" in result.data
            && result.data.cancelled === true
        ) {
            return result.speech ?? result.message;
        }
        const tool = this.get(name);
        return tool?.responsePolicy?.format?.(result)
            ?? result.speech
            ?? result.message;
    }

    serializationKey(name: string, input: unknown): string | undefined {
        const tool = this.get(name);
        return tool?.serializeKey?.(input);
    }

    modelSchemas(selection: ToolSelection = {}): ModelToolSchema[] {
        const selectedNames = selection.names
            ? new Set(selection.names.map(normalizeName))
            : null;
        const selectedCategories = selection.categories
            ? new Set(selection.categories)
            : null;

        return [...this.tools.values()]
            .filter(tool => (
                (!selectedNames || selectedNames.has(normalizeName(tool.name)))
                && (!selectedCategories || selectedCategories.has(tool.category))
            ))
            .map(tool => ({
                type: "function" as const,
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                },
            }));
    }

    list(): ReadonlyArray<Pick<RegisteredTool,
        | "name"
        | "description"
        | "category"
        | "capabilities"
        | "confirmationLevel"
        | "executionMode"
    >> {
        return [...this.tools.values()].map(tool => ({
            name: tool.name,
            description: tool.description,
            category: tool.category,
            capabilities: tool.capabilities,
            confirmationLevel: tool.confirmationLevel,
            executionMode: tool.executionMode,
        }));
    }

    private resolveName(name: string): string | null {
        return this.aliases.get(normalizeName(name)) ?? null;
    }

    private pendingQueue(
        conversationId: string,
        create = false,
    ): Map<string, PendingToolConfirmation> | undefined {
        let queue = this.pendingConfirmations.get(conversationId);
        if (queue) {
            const now = Date.now();
            for (const [confirmationId, pending] of queue) {
                if (pending.expiresAt <= now) queue.delete(confirmationId);
            }
            if (queue.size === 0) {
                this.pendingConfirmations.delete(conversationId);
                queue = undefined;
            }
        }

        if (!queue && create) {
            queue = new Map();
            this.pendingConfirmations.set(conversationId, queue);
        }
        return queue;
    }

    private takePendingConfirmation(
        conversationId: string,
        confirmationId?: string,
    ): PendingToolConfirmation | null {
        const queue = this.pendingQueue(conversationId);
        if (!queue) return null;
        const pending = confirmationId
            ? queue.get(confirmationId)
            : queue.values().next().value as PendingToolConfirmation | undefined;
        if (!pending) return null;
        queue.delete(pending.confirmationId);
        if (queue.size === 0) this.pendingConfirmations.delete(conversationId);
        return pending;
    }

    private validateActiveApproval(
        tool: RegisteredTool,
        input: unknown,
        context: ToolContext,
    ): ToolResult | null {
        const approval = context.confirmation;
        if (tool.confirmationLevel === "none" || approval?.approved !== true) {
            return null;
        }

        const activeApproval = this.activeApprovals.get(approval.confirmationId);
        const active = activeApproval?.pending;
        const capabilityMatches = approval.capability === active?.capability
            && (tool.capabilities.includes(approval.capability)
                || (tool.capabilities.length === 0 && approval.capability === tool.name));
        const valid = activeApproval?.consumed === false
            && active !== undefined
            && active.conversationId === context.conversationId
            && active.toolName === tool.name
            && capabilityMatches
            && isDeepStrictEqual(active.input, input);
        if (valid) {
            activeApproval.consumed = true;
            return null;
        }

        const message = "A confirmação informada é inválida ou não está mais pendente.";
        return {
            success: false,
            status: "unknown",
            message,
            speech: message,
            error: {
                code: "CONFIRMATION_INVALID",
                message,
                retryable: false,
            },
        };
    }
}
