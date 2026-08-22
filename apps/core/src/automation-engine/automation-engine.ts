import { join } from "node:path";

import { ActionRunner } from "./action-runner.ts";
import { ConditionRunner } from "./condition-runner.ts";
import {
    createActionId,
    createAutomationId,
    createConditionId,
    createJobId,
} from "./ids.ts";
import {
    Scheduler,
    type JobExecutionContext,
    type SchedulerOptions,
} from "./scheduler.ts";
import { AutomationStore, JobStore } from "./stores.ts";
import { TriggerEngine } from "./trigger-engine.ts";
import type {
    Automation,
    AutomationCreateInput,
    AutomationId,
    Job,
    JobId,
    JobRunResult,
    JsonObject,
    RetryPolicy,
    TriggerEvent,
} from "./types.ts";

const DEFAULT_RETRY_POLICY: RetryPolicy = {
    maxRetries: 3,
    baseDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 60_000,
};

export interface AutomationEngineOptions extends SchedulerOptions {
    readonly storageDirectory: string;
    readonly defaultTimezone?: string;
    readonly retryPolicy?: Partial<RetryPolicy>;
    readonly actionRunner?: ActionRunner;
    readonly conditionRunner?: ConditionRunner;
}

export class AutomationEngine {
    readonly automations: AutomationStore;
    readonly jobs: JobStore;
    readonly actions: ActionRunner;
    readonly conditions: ConditionRunner;
    readonly triggers: TriggerEngine;
    readonly scheduler: Scheduler;
    readonly retryPolicy: RetryPolicy;

    private started = false;

    constructor(options: AutomationEngineOptions) {
        this.automations = new AutomationStore(
            join(options.storageDirectory, "automations.json"),
        );
        this.jobs = new JobStore(join(options.storageDirectory, "jobs.json"));
        this.actions = options.actionRunner ?? new ActionRunner();
        this.conditions = options.conditionRunner ?? new ConditionRunner();
        this.triggers = new TriggerEngine(options.defaultTimezone ?? "UTC");
        this.retryPolicy = normalizeRetryPolicy(options.retryPolicy);
        this.scheduler = new Scheduler(
            this.jobs,
            this.triggers,
            (job, context) => this.executeJob(job, context),
            {
                pollIntervalMs: options.pollIntervalMs,
                maxConcurrency: options.maxConcurrency,
                onError: options.onError,
            },
        );
    }

    async createAutomation(input: AutomationCreateInput): Promise<Automation> {
        const name = input.name.trim();
        if (name.length === 0) {
            throw new TypeError("Automation name cannot be empty.");
        }
        if (input.actions.length === 0) {
            throw new TypeError("An automation needs at least one action.");
        }
        this.triggers.validate(input.trigger);

        const now = new Date();
        const automation: Automation = {
            id: input.id ?? createAutomationId(),
            name,
            ...(input.description === undefined
                ? {}
                : { description: input.description }),
            trigger: structuredClone(input.trigger),
            conditions: (input.conditions ?? []).map((condition) => ({
                ...structuredClone(condition),
                id: condition.id ?? createConditionId(),
            })),
            actions: input.actions.map((action) => ({
                ...structuredClone(action),
                id: action.id ?? createActionId(),
            })),
            status: input.status ?? "enabled",
            timezone: input.timezone ?? this.triggers.timezoneFor(input.trigger),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            ...(input.metadata === undefined
                ? {}
                : { metadata: structuredClone(input.metadata) }),
        };

        await this.automations.put(automation);
        try {
            if (automation.status === "enabled" && automation.trigger.type === "time.schedule") {
                await this.createScheduledJob(automation, now);
            }
        } catch (error) {
            // Creation spans two atomic files. Roll back only the record created above.
            await this.automations.delete(automation.id).catch(() => undefined);
            throw error;
        }
        return automation;
    }

    async getAutomation(id: AutomationId): Promise<Automation | undefined> {
        return this.automations.get(id);
    }

    async listAutomations(): Promise<Automation[]> {
        return this.automations.list();
    }

    async deleteAutomation(id: AutomationId): Promise<boolean> {
        const existing = await this.automations.get(id);
        if (!existing) return false;

        const jobs = (await this.jobs.list()).filter(job => job.automationId === id);
        for (const job of jobs) {
            await this.scheduler.cancel(job.id);
            await this.jobs.delete(job.id);
        }

        return await this.automations.delete(id);
    }

    async start(signal?: AbortSignal): Promise<void> {
        if (this.started) {
            return;
        }
        signal?.throwIfAborted();
        this.started = true;

        try {
            const now = new Date();
            await this.scheduler.recoverInterruptedJobs(now);
            const startupEvent = this.triggers.createEvent(
                "system.startup",
                {},
                now,
            );
            await this.dispatch(startupEvent, true);
            await this.scheduler.start(signal);
        } catch (error) {
            this.started = false;
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.started = false;
        await this.scheduler.stop();
    }

    async dispatch(
        event: TriggerEvent,
        skipOutstanding = false,
    ): Promise<Job[]> {
        const automations = (await this.automations.list()).filter(
            (automation) => (
                automation.status === "enabled"
                && automation.trigger.type !== "time.schedule"
                && this.triggers.matches(automation.trigger, event)
            ),
        );
        const existingJobs = skipOutstanding ? await this.jobs.list() : [];
        const created: Job[] = [];

        for (const automation of automations) {
            if (
                skipOutstanding
                && existingJobs.some((job) => (
                    job.automationId === automation.id
                    && (job.status === "scheduled"
                        || job.status === "retrying"
                        || job.status === "running")
                ))
            ) {
                continue;
            }

            const delay = this.triggers.startupDelay(automation.trigger) ?? 0;
            const nextRun = new Date(Date.parse(event.occurredAt) + delay);
            const job = this.buildJob(automation, nextRun, event);
            await this.jobs.put(job);
            created.push(job);
        }
        return created;
    }

    async runNow(
        automationId: AutomationId,
        data: JsonObject = {},
    ): Promise<Job> {
        const automation = await this.automations.get(automationId);
        if (automation === undefined) {
            throw new Error(`Unknown automation: ${automationId}`);
        }
        if (automation.status === "archived") {
            throw new Error(`Archived automation cannot run: ${automationId}`);
        }

        const event = this.triggers.createEvent("automation.manual", data);
        const job = this.buildJob(
            {
                ...automation,
                trigger: { type: "automation.manual", config: {} },
            },
            new Date(),
            event,
        );
        await this.jobs.put(job);
        return job;
    }

    async cancelJob(jobId: JobId): Promise<boolean> {
        return this.scheduler.cancel(jobId);
    }

    private async createScheduledJob(
        automation: Automation,
        now: Date,
    ): Promise<Job> {
        const nextRun = this.triggers.nextRun(
            automation.trigger,
            new Date(now.getTime() - 1),
        );
        const job = this.buildJob(automation, nextRun);
        await this.jobs.put(job);
        return job;
    }

    private buildJob(
        automation: Automation,
        nextRun: Date | null,
        triggerEvent?: TriggerEvent,
    ): Job {
        const now = new Date().toISOString();
        return {
            id: createJobId(),
            automationId: automation.id,
            trigger: structuredClone(automation.trigger),
            conditions: structuredClone(automation.conditions),
            actions: structuredClone(automation.actions),
            status: nextRun === null ? "completed" : "scheduled",
            timezone: automation.timezone,
            nextRun: nextRun?.toISOString() ?? null,
            createdAt: now,
            updatedAt: now,
            attempts: 0,
            retryCount: 0,
            retryPolicy: structuredClone(this.retryPolicy),
            ...(triggerEvent === undefined
                ? {}
                : { triggerEvent: structuredClone(triggerEvent) }),
        };
    }

    private async executeJob(
        job: Job,
        context: JobExecutionContext,
    ): Promise<JobRunResult> {
        const conditionResult = await this.conditions.evaluate(job.conditions, {
            signal: context.signal,
            automationId: job.automationId,
            jobId: job.id,
            runId: context.runId,
            triggerEvent: job.triggerEvent,
        });
        if (!conditionResult.matched) {
            return { status: "skipped", conditionResult };
        }

        const actionResult = await this.actions.execute(job.actions, {
            signal: context.signal,
            automationId: job.automationId,
            jobId: job.id,
            runId: context.runId,
            triggerEvent: job.triggerEvent,
        });
        if (actionResult.status === "failed") {
            const failedAction = actionResult.actions.find(
                (action) => action.status === "failed",
            );
            return {
                status: "failed",
                conditionResult,
                actionResult,
                error: failedAction?.error ?? "One or more actions failed.",
            };
        }
        return { status: "succeeded", conditionResult, actionResult };
    }
}

function normalizeRetryPolicy(input: Partial<RetryPolicy> | undefined): RetryPolicy {
    const policy: RetryPolicy = {
        ...DEFAULT_RETRY_POLICY,
        ...input,
    };
    if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) {
        throw new RangeError("maxRetries must be a non-negative integer.");
    }
    if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
        throw new RangeError("baseDelayMs must be non-negative.");
    }
    if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) {
        throw new RangeError("retry multiplier must be at least 1.");
    }
    if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < 0) {
        throw new RangeError("maxDelayMs must be non-negative.");
    }
    return policy;
}
