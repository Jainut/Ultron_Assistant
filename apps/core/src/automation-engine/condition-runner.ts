import type {
    AutomationId,
    Condition,
    ConditionBatchResult,
    ConditionExecutionResult,
    JobId,
    JsonObject,
    RunId,
    TriggerEvent,
} from "./types.ts";

export interface ConditionExecutionContext {
    readonly signal?: AbortSignal;
    readonly automationId: AutomationId;
    readonly jobId: JobId;
    readonly runId: RunId;
    readonly triggerEvent?: TriggerEvent;
    readonly previousResults: readonly ConditionExecutionResult[];
}

export type ConditionHandler<TParameters extends JsonObject = JsonObject> = (
    parameters: TParameters,
    context: ConditionExecutionContext,
) => Promise<boolean> | boolean;

export class ConditionRunner {
    private readonly handlers = new Map<string, ConditionHandler>();

    constructor() {
        this.register("always", () => true);
    }

    register<TParameters extends JsonObject>(
        type: string,
        handler: ConditionHandler<TParameters>,
        options: { readonly replace?: boolean } = {},
    ): () => void {
        const normalizedType = type.trim();
        if (normalizedType.length === 0) {
            throw new TypeError("Condition type cannot be empty.");
        }
        if (this.handlers.has(normalizedType) && !options.replace) {
            throw new Error(`Condition handler already registered: ${normalizedType}`);
        }

        const registeredHandler = handler as unknown as ConditionHandler;
        this.handlers.set(normalizedType, registeredHandler);
        return () => {
            if (this.handlers.get(normalizedType) === registeredHandler) {
                this.handlers.delete(normalizedType);
            }
        };
    }

    async evaluate(
        conditions: readonly Condition[],
        context: Omit<ConditionExecutionContext, "previousResults">,
    ): Promise<ConditionBatchResult> {
        const results: ConditionExecutionResult[] = [];

        for (const condition of conditions) {
            context.signal?.throwIfAborted();
            const handler = this.handlers.get(condition.type);
            if (handler === undefined) {
                throw new Error(`No condition handler registered for ${condition.type}`);
            }

            const rawMatch = await handler(condition.parameters, {
                ...context,
                previousResults: results,
            });
            context.signal?.throwIfAborted();
            const matched = condition.negate ? !rawMatch : rawMatch;
            results.push({
                conditionId: condition.id,
                conditionType: condition.type,
                matched,
                evaluatedAt: new Date().toISOString(),
            });
            if (!matched) {
                return { matched: false, conditions: results };
            }
        }

        return { matched: true, conditions: results };
    }
}
