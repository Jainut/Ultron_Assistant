export interface ToolContext {
    signal?: AbortSignal;
}

export interface Tool<TInput, TOutput> {
    readonly name: string;
    readonly description: string;
    readonly category: "system" | "filesystem" | "smart-home" | "information";

    execute(input: TInput, context?: ToolContext): Promise<TOutput>;
}

export function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}
