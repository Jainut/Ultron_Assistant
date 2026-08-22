export type ActionStatus =
    | "accepted"
    | "confirmed"
    | "optimistic"
    | "failed"
    | "unknown";

export interface ToolResult<T = unknown> {
    success: boolean;
    /**
     * Estado operacional da ação. É opcional apenas para manter
     * compatibilidade com tools antigas durante a migração incremental.
     * O ToolRegistry sempre normaliza este campo antes de devolver o resultado.
     */
    status?: ActionStatus;
    message: string;
    speech?: string;
    shouldSpeak?: boolean;
    data?: T;
    error?: {
        code?: string;
        message: string;
        retryable?: boolean;
    };
}
