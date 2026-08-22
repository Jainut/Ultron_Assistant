import type { ToolResult } from "../../shared/types.ts";

export interface ToolResponseFormatter {
    formatResponse(name: string, result: ToolResult): string;
}

export interface CompletedToolResponse {
    readonly name: string;
    readonly result: ToolResult;
}

/**
 * Resume várias execuções sem promover `accepted`, `optimistic` ou `unknown`
 * para uma confirmação que o provider nunca forneceu.
 */
export function formatToolExecutionResponses(
    formatter: ToolResponseFormatter,
    executions: readonly CompletedToolResponse[],
): string {
    if (executions.length === 0) return "";

    const responses = executions.map(({ name, result }) => (
        formatter.formatResponse(name, result)
    ));

    if (executions.length === 1) return responses[0];

    const allPhysicallyConfirmed = executions.every(({ result }) => (
        result.success && result.status === "confirmed"
    ));

    if (allPhysicallyConfirmed) return "Feito.";

    return [...new Set(responses.filter(Boolean))].join(" ");
}
