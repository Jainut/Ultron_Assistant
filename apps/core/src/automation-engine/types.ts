export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
    /** Optional object properties are omitted by JSON.stringify. */
    [key: string]: JsonValue | undefined;
}

export type IsoDateTime = string;
export type AutomationId = `automation_${string}`;
export type JobId = `job_${string}`;
export type RunId = `run_${string}`;
export type ActionId = `action_${string}`;
export type ConditionId = `condition_${string}`;
export type TriggerEventId = `event_${string}`;

export interface Trigger<
    TType extends string = string,
    TConfig extends JsonObject = JsonObject,
> {
    readonly type: TType;
    readonly config: TConfig;
}

export interface OnceSchedule extends JsonObject {
    readonly kind: "once";
    readonly at: IsoDateTime;
    readonly timezone?: string;
}

export interface IntervalSchedule extends JsonObject {
    readonly kind: "interval";
    readonly everyMs: number;
    readonly startAt?: IsoDateTime;
    readonly endAt?: IsoDateTime;
    readonly timezone?: string;
}

export interface DailySchedule extends JsonObject {
    readonly kind: "daily";
    /** Local wall-clock time in HH:mm or HH:mm:ss format. */
    readonly time: string;
    readonly timezone: string;
    /** JavaScript day numbers: Sunday=0 through Saturday=6. */
    readonly daysOfWeek?: number[];
}

export type TimeSchedule = OnceSchedule | IntervalSchedule | DailySchedule;

export interface TimeScheduleTriggerConfig extends JsonObject {
    readonly schedule: TimeSchedule;
}

export type TimeScheduleTrigger = Trigger<
    "time.schedule",
    TimeScheduleTriggerConfig
>;

export interface SystemStartupTriggerConfig extends JsonObject {
    readonly delayMs?: number;
}

export type SystemStartupTrigger = Trigger<
    "system.startup",
    SystemStartupTriggerConfig
>;

export interface TriggerEvent<
    TType extends string = string,
    TData extends JsonObject = JsonObject,
> {
    readonly id: TriggerEventId;
    readonly type: TType;
    readonly occurredAt: IsoDateTime;
    readonly data: TData;
}

export interface Condition<
    TParameters extends JsonObject = JsonObject,
> {
    readonly id: ConditionId;
    readonly type: string;
    readonly parameters: TParameters;
    readonly negate?: boolean;
}

export interface Action<TInput extends JsonValue = JsonValue> {
    readonly id: ActionId;
    readonly type: string;
    readonly input: TInput;
    /** Continue subsequent actions when this action fails. */
    readonly continueOnError?: boolean;
}

export type AutomationStatus =
    | "enabled"
    | "paused"
    | "disabled"
    | "archived";

export interface Automation {
    readonly id: AutomationId;
    readonly name: string;
    readonly description?: string;
    readonly trigger: Trigger;
    readonly conditions: Condition[];
    readonly actions: Action[];
    readonly status: AutomationStatus;
    readonly timezone: string;
    readonly createdAt: IsoDateTime;
    readonly updatedAt: IsoDateTime;
    readonly metadata?: JsonObject;
}

export type JobStatus =
    | "scheduled"
    | "running"
    | "retrying"
    | "paused"
    | "completed"
    | "skipped"
    | "failed"
    | "cancelled";

export interface RetryPolicy extends JsonObject {
    readonly maxRetries: number;
    readonly baseDelayMs: number;
    readonly multiplier: number;
    readonly maxDelayMs: number;
}

export interface JobError extends JsonObject {
    readonly message: string;
    readonly code?: string;
    readonly at: IsoDateTime;
    readonly retryable: boolean;
    /** A failed response/cancellation cannot prove that external effects did not happen. */
    readonly outcome?: "unknown";
    /** The runtime refused to repeat this occurrence to avoid duplicate effects. */
    readonly retrySuppressed?: boolean;
}

export interface PersistedJobResult extends JsonObject {
    readonly runId: RunId;
    readonly status: "succeeded" | "skipped" | "failed";
    readonly startedAt: IsoDateTime;
    readonly finishedAt: IsoDateTime;
}

export interface Job {
    readonly id: JobId;
    readonly automationId: AutomationId;
    readonly trigger: Trigger;
    readonly conditions: Condition[];
    readonly actions: Action[];
    readonly status: JobStatus;
    readonly timezone: string;
    readonly nextRun: IsoDateTime | null;
    readonly createdAt: IsoDateTime;
    readonly updatedAt: IsoDateTime;
    readonly attempts: number;
    readonly retryCount: number;
    readonly retryPolicy: RetryPolicy;
    readonly lastRunAt?: IsoDateTime;
    readonly lastCompletedAt?: IsoDateTime;
    readonly lastError?: JobError;
    readonly lastResult?: PersistedJobResult;
    readonly currentRunId?: RunId;
    readonly triggerEvent?: TriggerEvent;
}

export type ActionExecutionStatus = "succeeded" | "failed" | "cancelled";

export interface ActionExecutionResult {
    readonly actionId: ActionId;
    readonly actionType: string;
    readonly status: ActionExecutionStatus;
    readonly startedAt: IsoDateTime;
    readonly finishedAt: IsoDateTime;
    readonly output?: JsonValue;
    readonly error?: string;
}

export interface ActionBatchResult {
    readonly status: "succeeded" | "failed";
    readonly startedAt: IsoDateTime;
    readonly finishedAt: IsoDateTime;
    readonly actions: ActionExecutionResult[];
}

export interface ConditionExecutionResult {
    readonly conditionId: ConditionId;
    readonly conditionType: string;
    readonly matched: boolean;
    readonly evaluatedAt: IsoDateTime;
}

export interface ConditionBatchResult {
    readonly matched: boolean;
    readonly conditions: ConditionExecutionResult[];
}

export interface JobRunResult {
    readonly status: "succeeded" | "skipped" | "failed";
    readonly actionResult?: ActionBatchResult;
    readonly conditionResult?: ConditionBatchResult;
    readonly error?: string;
}

export interface AutomationCreateInput {
    readonly id?: AutomationId;
    readonly name: string;
    readonly description?: string;
    readonly trigger: Trigger;
    readonly conditions?: Array<Omit<Condition, "id"> & { readonly id?: ConditionId }>;
    readonly actions: Array<Omit<Action, "id"> & { readonly id?: ActionId }>;
    readonly status?: AutomationStatus;
    readonly timezone?: string;
    readonly metadata?: JsonObject;
}

export interface PersistedEntity {
    readonly id: string;
}
