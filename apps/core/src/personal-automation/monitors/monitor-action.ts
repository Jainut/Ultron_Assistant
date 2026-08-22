import type { ActionExecutionContext } from "../../automation-engine/action-runner.ts";
import type {
    JsonObject,
} from "../../automation-engine/types.ts";

export type MonitorCategory = "mail" | "calendar";

export interface MonitorActionDefinition<
    TInput extends JsonObject,
    TOutput extends JsonObject,
> {
    readonly type: string;
    readonly category: MonitorCategory;
    readonly execute: (
        input: TInput,
        context: ActionExecutionContext,
    ) => Promise<TOutput> | TOutput;
}

export interface MonitorActionRuntimeContext extends ActionExecutionContext {}
