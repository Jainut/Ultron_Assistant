import { randomUUID } from "node:crypto";

import type {
    ActionId,
    AutomationId,
    ConditionId,
    JobId,
    RunId,
    TriggerEventId,
} from "./types.ts";

export function createAutomationId(): AutomationId {
    return `automation_${randomUUID()}`;
}

export function createJobId(): JobId {
    return `job_${randomUUID()}`;
}

export function createRunId(): RunId {
    return `run_${randomUUID()}`;
}

export function createActionId(): ActionId {
    return `action_${randomUUID()}`;
}

export function createConditionId(): ConditionId {
    return `condition_${randomUUID()}`;
}

export function createTriggerEventId(): TriggerEventId {
    return `event_${randomUUID()}`;
}
