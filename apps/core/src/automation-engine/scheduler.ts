import { createRunId } from "./ids.ts";
import { isAbortError } from "./action-runner.ts";
import { JobStore } from "./stores.ts";
import { TriggerEngine } from "./trigger-engine.ts";
import type {
    IsoDateTime,
    Job,
    JobError,
    JobId,
    JobRunResult,
    RunId,
} from "./types.ts";

export interface JobExecutionContext {
    readonly signal: AbortSignal;
    readonly runId: RunId;
    readonly startedAt: IsoDateTime;
}

export type JobExecutor = (
    job: Job,
    context: JobExecutionContext,
) => Promise<JobRunResult>;

export interface SchedulerOptions {
    /** Fixed upper bound between durable-store checks; never a next-run timeout. */
    readonly pollIntervalMs?: number;
    readonly maxConcurrency?: number;
    readonly onError?: (error: unknown) => void;
}

interface ActiveJob {
    readonly controller: AbortController;
    readonly promise: Promise<void>;
}

export class Scheduler {
    private readonly pollIntervalMs: number;
    private readonly maxConcurrency: number;
    private readonly onError: (error: unknown) => void;
    private readonly activeJobs = new Map<JobId, ActiveJob>();
    private readonly cancellationRequests = new Set<JobId>();

    private started = false;
    private pollTimer?: NodeJS.Timeout;
    private lifetimeController?: AbortController;
    private removeExternalAbortListener?: () => void;
    private tickInFlight?: Promise<void>;

    constructor(
        readonly jobs: JobStore,
        readonly triggers: TriggerEngine,
        private readonly executor: JobExecutor,
        options: SchedulerOptions = {},
    ) {
        this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
        this.maxConcurrency = options.maxConcurrency ?? 2;
        this.onError = options.onError ?? (() => undefined);

        if (
            !Number.isFinite(this.pollIntervalMs)
            || this.pollIntervalMs < 10
            || this.pollIntervalMs > 60_000
        ) {
            throw new RangeError("pollIntervalMs must be between 10 and 60000.");
        }
        if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
            throw new RangeError("maxConcurrency must be a positive integer.");
        }
    }

    get isRunning(): boolean {
        return this.started;
    }

    async start(signal?: AbortSignal): Promise<void> {
        if (this.started) {
            return;
        }
        signal?.throwIfAborted();

        this.started = true;
        this.lifetimeController = new AbortController();
        if (signal !== undefined) {
            const abort = () => void this.stop();
            signal.addEventListener("abort", abort, { once: true });
            this.removeExternalAbortListener = () => {
                signal.removeEventListener("abort", abort);
            };
        }

        try {
            await this.recoverInterruptedJobs(new Date());
            await this.tick(new Date(), this.lifetimeController.signal);
            this.scheduleNextPoll();
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (!this.started && this.activeJobs.size === 0) {
            return;
        }

        this.started = false;
        if (this.pollTimer !== undefined) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.removeExternalAbortListener?.();
        this.removeExternalAbortListener = undefined;
        this.lifetimeController?.abort(new DOMException("Scheduler stopped", "AbortError"));

        const active = [...this.activeJobs.values()].map((job) => job.promise);
        await Promise.allSettled(active);
        this.lifetimeController = undefined;
    }

    /**
     * Runs one bounded poll. Public to support deterministic health checks and
     * tests without waiting for a wall-clock timer.
     */
    async tick(now = new Date(), signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (Number.isNaN(now.getTime())) {
            throw new RangeError("Invalid scheduler tick date.");
        }
        if (this.tickInFlight !== undefined) {
            return this.tickInFlight;
        }

        const run = this.runTick(now, signal);
        this.tickInFlight = run;
        try {
            await run;
        } finally {
            if (this.tickInFlight === run) {
                this.tickInFlight = undefined;
            }
        }
    }

    async cancel(jobId: JobId): Promise<boolean> {
        const active = this.activeJobs.get(jobId);
        if (active !== undefined) {
            this.cancellationRequests.add(jobId);
            active.controller.abort(new DOMException("Job cancelled", "AbortError"));
            await active.promise;
            return true;
        }

        const updated = await this.jobs.update(jobId, (job) => ({
            ...job,
            status: "cancelled",
            nextRun: null,
            updatedAt: new Date().toISOString(),
            currentRunId: undefined,
        }));
        return updated !== undefined;
    }

    async recoverInterruptedJobs(now = new Date()): Promise<number> {
        const jobs = await this.jobs.list();
        const recovered = jobs
            .filter((job) => job.status === "running")
            .map((job): Job => ({
                ...job,
                status: "retrying",
                nextRun: now.toISOString(),
                updatedAt: now.toISOString(),
                currentRunId: undefined,
                lastError: {
                    message: "The previous process stopped while this job was running.",
                    code: "INTERRUPTED",
                    at: now.toISOString(),
                    retryable: true,
                },
            }));
        if (recovered.length > 0) {
            await this.jobs.putMany(recovered);
        }
        return recovered.length;
    }

    private scheduleNextPoll(): void {
        if (!this.started || this.pollTimer !== undefined) {
            return;
        }
        this.pollTimer = setTimeout(() => {
            this.pollTimer = undefined;
            const signal = this.lifetimeController?.signal;
            void this.tick(new Date(), signal)
                .catch((error) => {
                    if (!isAbortError(error)) {
                        this.onError(error);
                    }
                })
                .finally(() => this.scheduleNextPoll());
        }, this.pollIntervalMs);
    }

    private async runTick(now: Date, signal?: AbortSignal): Promise<void> {
        const dueJobs = (await this.jobs.list())
            .filter((job) => (
                (job.status === "scheduled" || job.status === "retrying")
                && job.nextRun !== null
                && dateValue(job.nextRun) <= now.getTime()
                && !this.activeJobs.has(job.id)
            ))
            .sort((left, right) => dateValue(left.nextRun!) - dateValue(right.nextRun!));

        let cursor = 0;
        const errors: unknown[] = [];
        const workerCount = Math.min(this.maxConcurrency, dueJobs.length);
        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (cursor < dueJobs.length) {
                signal?.throwIfAborted();
                const index = cursor;
                cursor += 1;
                try {
                    await this.runJob(dueJobs[index]!, now, signal);
                } catch (error) {
                    errors.push(error);
                }
            }
        }));

        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, "Multiple scheduled jobs failed to persist.");
        }
    }

    private async runJob(
        candidate: Job,
        now: Date,
        schedulerSignal?: AbortSignal,
    ): Promise<void> {
        if (this.activeJobs.has(candidate.id)) {
            return;
        }

        const current = await this.jobs.get(candidate.id);
        if (
            current === undefined
            || (current.status !== "scheduled" && current.status !== "retrying")
            || current.nextRun === null
            || dateValue(current.nextRun) > now.getTime()
        ) {
            return;
        }

        const runId = createRunId();
        const startedAt = new Date().toISOString();
        const running: Job = {
            ...current,
            status: "running",
            attempts: current.attempts + 1,
            lastRunAt: startedAt,
            updatedAt: startedAt,
            currentRunId: runId,
        };
        await this.jobs.put(running);

        const linked = linkedAbortController(schedulerSignal);
        const promise = this.executeRunningJob(running, runId, startedAt, linked.controller)
            .finally(() => {
                linked.dispose();
                this.activeJobs.delete(running.id);
                this.cancellationRequests.delete(running.id);
            });
        this.activeJobs.set(running.id, {
            controller: linked.controller,
            promise,
        });
        await promise;
    }

    private async executeRunningJob(
        job: Job,
        runId: RunId,
        startedAt: IsoDateTime,
        controller: AbortController,
    ): Promise<void> {
        try {
            const result = await this.executor(job, {
                signal: controller.signal,
                runId,
                startedAt,
            });
            controller.signal.throwIfAborted();
            if (result.status === "failed") {
                await this.saveFailure(job, runId, new Error(result.error ?? "Job failed."));
                return;
            }

            const finishedAt = new Date();
            const nextRun = this.triggers.nextRun(job.trigger, finishedAt);
            await this.jobs.update(job.id, (latest) => {
                if (latest.currentRunId !== runId) {
                    return latest;
                }
                return {
                    ...latest,
                    status: nextRun === null
                        ? result.status === "skipped" ? "skipped" : "completed"
                        : "scheduled",
                    nextRun: nextRun?.toISOString() ?? null,
                    updatedAt: finishedAt.toISOString(),
                    lastCompletedAt: finishedAt.toISOString(),
                    retryCount: 0,
                    currentRunId: undefined,
                    lastError: undefined,
                    lastResult: {
                        runId,
                        status: result.status,
                        startedAt,
                        finishedAt: finishedAt.toISOString(),
                    },
                };
            });
        } catch (error) {
            if (isAbortError(error) || controller.signal.aborted) {
                await this.saveCancellation(job, runId);
                return;
            }
            await this.saveFailure(job, runId, error);
        }
    }

    private async saveCancellation(job: Job, runId: RunId): Promise<void> {
        const cancelledByUser = this.cancellationRequests.has(job.id);
        const now = new Date().toISOString();
        await this.jobs.update(job.id, (latest) => {
            if (latest.currentRunId !== runId) {
                return latest;
            }
            return {
                ...latest,
                status: cancelledByUser ? "cancelled" : "scheduled",
                nextRun: cancelledByUser ? null : latest.nextRun,
                updatedAt: now,
                currentRunId: undefined,
            };
        });
    }

    private async saveFailure(job: Job, runId: RunId, error: unknown): Promise<void> {
        const failedAt = new Date();
        const nextRetryCount = job.retryCount + 1;
        const willRetry = nextRetryCount <= job.retryPolicy.maxRetries;
        const jobError = normalizeJobError(error, failedAt, willRetry);
        const retryAt = willRetry
            ? new Date(failedAt.getTime() + retryDelay(job, nextRetryCount)).toISOString()
            : null;
        // Esgotar os retries encerra esta ocorrência, não a definição
        // recorrente. Avance a partir do instante da falha para não reproduzir
        // em rajada ocorrências que venceram durante o backoff.
        const nextRecurringRun = willRetry
            ? null
            : this.nextRecurringRun(job, failedAt);
        const continuesRecurring = nextRecurringRun !== null;

        await this.jobs.update(job.id, (latest) => {
            if (latest.currentRunId !== runId) {
                return latest;
            }
            return {
                ...latest,
                status: willRetry
                    ? "retrying"
                    : continuesRecurring ? "scheduled" : "failed",
                nextRun: retryAt ?? nextRecurringRun?.toISOString() ?? null,
                updatedAt: failedAt.toISOString(),
                // A próxima ocorrência ganha seu próprio orçamento de retry.
                retryCount: continuesRecurring ? 0 : nextRetryCount,
                currentRunId: undefined,
                lastError: jobError,
                lastResult: {
                    runId,
                    status: "failed",
                    startedAt: latest.lastRunAt ?? failedAt.toISOString(),
                    finishedAt: failedAt.toISOString(),
                },
            };
        });
    }

    private nextRecurringRun(job: Job, after: Date): Date | null {
        if (job.trigger.type !== "time.schedule") return null;
        const schedule = job.trigger.config.schedule;
        if (
            schedule === null
            || typeof schedule !== "object"
            || Array.isArray(schedule)
            || (schedule.kind !== "interval" && schedule.kind !== "daily")
        ) {
            return null;
        }
        return this.triggers.nextRun(job.trigger, after);
    }
}

function retryDelay(job: Job, retryNumber: number): number {
    const unbounded = job.retryPolicy.baseDelayMs
        * job.retryPolicy.multiplier ** Math.max(0, retryNumber - 1);
    return Math.min(job.retryPolicy.maxDelayMs, Math.round(unbounded));
}

function normalizeJobError(error: unknown, at: Date, retryable: boolean): JobError {
    const code = error instanceof Error
        && "code" in error
        && typeof error.code === "string"
        ? error.code
        : undefined;
    return {
        message: error instanceof Error ? error.message : String(error),
        ...(code === undefined ? {} : { code }),
        at: at.toISOString(),
        retryable,
    };
}

function dateValue(value: string): number {
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
        throw new RangeError(`Invalid persisted job date: ${value}`);
    }
    return timestamp;
}

function linkedAbortController(signal?: AbortSignal): {
    readonly controller: AbortController;
    readonly dispose: () => void;
} {
    const controller = new AbortController();
    if (signal === undefined) {
        return { controller, dispose: () => undefined };
    }
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) {
        abort();
        return { controller, dispose: () => undefined };
    }
    signal.addEventListener("abort", abort, { once: true });
    return {
        controller,
        dispose: () => signal.removeEventListener("abort", abort),
    };
}
