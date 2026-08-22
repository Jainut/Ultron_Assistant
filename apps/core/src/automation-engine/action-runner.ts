import type {
    Action,
    ActionBatchResult,
    ActionExecutionResult,
    AutomationId,
    JobId,
    JsonValue,
    RunId,
    TriggerEvent,
} from "./types.ts";

export interface ActionExecutionContext {
    readonly signal?: AbortSignal;
    readonly automationId: AutomationId;
    readonly jobId: JobId;
    readonly runId: RunId;
    readonly triggerEvent?: TriggerEvent;
    readonly previousResults: readonly ActionExecutionResult[];
}

export type ActionHandler<
    TInput extends JsonValue = JsonValue,
    TOutput extends JsonValue = JsonValue,
> = (
    input: TInput,
    context: ActionExecutionContext,
) => Promise<TOutput | void> | TOutput | void;

export interface RegisterActionOptions {
    readonly replace?: boolean;
}

export class ActionRunner {
    private readonly handlers = new Map<string, ActionHandler>();

    register<TInput extends JsonValue, TOutput extends JsonValue>(
        type: string,
        handler: ActionHandler<TInput, TOutput>,
        options: RegisterActionOptions = {},
    ): () => void {
        const normalizedType = type.trim();
        if (normalizedType.length === 0) {
            throw new TypeError("Action type cannot be empty.");
        }
        if (this.handlers.has(normalizedType) && !options.replace) {
            throw new Error(`Action handler already registered: ${normalizedType}`);
        }

        const registeredHandler = handler as unknown as ActionHandler;
        this.handlers.set(normalizedType, registeredHandler);
        return () => {
            if (this.handlers.get(normalizedType) === registeredHandler) {
                this.handlers.delete(normalizedType);
            }
        };
    }

    has(type: string): boolean {
        return this.handlers.has(type);
    }

    registeredTypes(): string[] {
        return [...this.handlers.keys()].sort();
    }

    async execute(
        actions: readonly Action[],
        context: Omit<ActionExecutionContext, "previousResults">,
    ): Promise<ActionBatchResult> {
        const startedAt = new Date().toISOString();
        const results: ActionExecutionResult[] = [];
        let failed = false;

        for (const action of actions) {
            context.signal?.throwIfAborted();
            const actionStartedAt = new Date().toISOString();
            const handler = this.handlers.get(action.type);

            if (handler === undefined) {
                failed = true;
                results.push({
                    actionId: action.id,
                    actionType: action.type,
                    status: "failed",
                    startedAt: actionStartedAt,
                    finishedAt: new Date().toISOString(),
                    error: `No action handler registered for ${action.type}`,
                });
                if (!action.continueOnError) {
                    break;
                }
                continue;
            }

            try {
                const output = await handler(action.input, {
                    ...context,
                    previousResults: results,
                });
                context.signal?.throwIfAborted();
                results.push({
                    actionId: action.id,
                    actionType: action.type,
                    status: "succeeded",
                    startedAt: actionStartedAt,
                    finishedAt: new Date().toISOString(),
                    ...(output === undefined ? {} : { output }),
                });
            } catch (error) {
                if (isAbortError(error) || context.signal?.aborted) {
                    throw error;
                }

                failed = true;
                results.push({
                    actionId: action.id,
                    actionType: action.type,
                    status: "failed",
                    startedAt: actionStartedAt,
                    finishedAt: new Date().toISOString(),
                    error: errorMessage(error),
                });
                if (!action.continueOnError) {
                    break;
                }
            }
        }

        return {
            status: failed ? "failed" : "succeeded",
            startedAt,
            finishedAt: new Date().toISOString(),
            actions: results,
        };
    }
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
