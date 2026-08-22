import type { ActionStatus, ToolResult } from "../../shared/types.ts";

export type ToolCategory =
    | "system"
    | "filesystem"
    | "smart-home"
    | "information"
    | "mail"
    | "tasks"
    | "calendar"
    | "automation";

export type ConfirmationLevel =
    | "none"
    | "confirm-before-execute"
    | "dangerous";

export type ToolExecutionMode = "sync" | "async" | "background";

export interface ToolConfirmation {
    approved: boolean;
    capability: string;
    confirmationId: string;
}

export interface ToolCapabilityGrant {
    /** Undefined preserves the current unrestricted local mode. */
    allowed?: readonly string[];
    denied?: readonly string[];
}

export interface ToolContext {
    signal?: AbortSignal;
    requestId?: string;
    conversationId?: string;
    toolCallId?: string;
    automationId?: string;
    jobId?: string;
    runId?: string;
    confirmation?: ToolConfirmation;
    capabilityGrant?: ToolCapabilityGrant;
}

export interface JsonSchema {
    type: string;
    properties?: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
}

export interface ToolResponsePolicy<TData = unknown> {
    deterministic?: boolean;
    format?: (result: ToolResult<TData>) => string;
}

export interface ToolDefinition<TInput, TData = unknown> {
    readonly name: string;
    readonly description: string;
    readonly category: ToolCategory;
    readonly inputSchema: JsonSchema;
    readonly aliases?: readonly string[];
    readonly capabilities: readonly string[];
    readonly confirmationLevel: ConfirmationLevel;
    readonly executionMode: ToolExecutionMode;
    readonly successStatus?: Exclude<ActionStatus, "failed">;
    readonly serializeKey?: (input: TInput) => string;
    readonly responsePolicy?: ToolResponsePolicy<TData>;

    execute(input: TInput, context: ToolContext): Promise<ToolResult<TData>>;
}

/** Compatibilidade nominal para consumidores antigos durante a migração. */
export type Tool<TInput, TData = unknown> = ToolDefinition<TInput, TData>;

export function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}
