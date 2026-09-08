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

export interface JobRetryContext {
    readonly reason: "failure" | "recovery" | "shutdown" | "pending-retry";
    readonly error?: unknown;
}

export type JobRetryAuthorization = (job: Job, context: JobRetryContext) => boolean;

export interface SchedulerOptions {
    /** Fixed upper bound between durable-store checks; never a next-run timeout. */
    readonly pollIntervalMs?: number;
    readonly maxConcurrency?: number;
    readonly onError?: (error: unknown) => void;
    /** Omit to preserve generic retry behavior; runtimes can deny unsafe whole-job replays. */
    readonly canRetryJob?: JobRetryAuthorization;
    /** Default true preserves start() awaiting the first jobs; runtimes can arm polling without waiting for tools. */
    readonly awaitInitialTick?: boolean;
}

interface ActiveJob {
    readonly controller: AbortController;
    readonly promise: Promise<void>;
}

export class Scheduler {
    private readonly pollIntervalMs: number;
    private readonly maxConcurrency: number;
    private readonly onError: (error: unknown) => void;
    private readonly canRetryJob?: JobRetryAuthorization;
    private readonly awaitInitialTick: boolean;
    private readonly activeJobs = new Map<JobId, ActiveJob>();
    private readonly cancellationRequests = new Set<JobId>();

    private started = false;
    private pollTimer?: NodeJS.Timeout;
    private lifetimeController?: AbortController;
    private removeExternalAbortListener?: () => void;
    private tickInFlight?: Promise<void>;
    private tickController?: AbortController;
    private startInFlight?: Promise<void>;
    private stopInFlight?: Promise<void>;

    constructor(
        readonly jobs: JobStore,
        readonly triggers: TriggerEngine,
        private readonly executor: JobExecutor,
        options: SchedulerOptions = {},
    ) {
        this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
        this.maxConcurrency = options.maxConcurrency ?? 2;
        this.onError = options.onError ?? (() => undefined);
        this.canRetryJob = options.canRetryJob;
        this.awaitInitialTick = options.awaitInitialTick ?? true;

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
        if (this.stopInFlight) await this.stopInFlight;
        signal?.throwIfAborted();
        if (this.startInFlight) return this.startInFlight;
        if (this.started) {
            return;
        }
        const operation = this.startScheduler(signal);
        this.startInFlight = operation;
        try {
            await operation;
        } finally {
            if (this.startInFlight === operation) this.startInFlight = undefined;
        }
    }

    private async startScheduler(signal?: AbortSignal): Promise<void> {
        this.started = true;
        const lifetime = new AbortController();
        this.lifetimeController = lifetime;
        if (signal !== undefined) {
            const abort = () => void this.stop();
            signal.addEventListener("abort", abort, { once: true });
            this.removeExternalAbortListener = () => {
                signal.removeEventListener("abort", abort);
            };
        }

        try {
            await this.recoverInterruptedJobs(new Date(), lifetime.signal);
            lifetime.signal.throwIfAborted();
            const initialTick = this.tick(new Date(), lifetime.signal);
            if (this.awaitInitialTick) {
                await initialTick;
                this.scheduleNextPoll();
            } else {
                // The service is ready after recovery, not after every due tool finishes.
                // Poll only after this tick drains; stop() still aborts and awaits it.
                void initialTick.catch(error => {
                    if (!lifetime.signal.aborted && !isAbortError(error)) {
                        try { this.onError(error); } catch { /* Observer isolation. */ }
                    }
                }).finally(() => {
                    if (this.lifetimeController === lifetime) this.scheduleNextPoll();
                });
            }
        } catch (error) {
            // Do not await public stop(): it also drains this startup promise.
            await this.stopScheduler();
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (this.stopInFlight) return this.stopInFlight;
        const stopping = [this.stopScheduler()];
        if (this.startInFlight) stopping.push(this.startInFlight);
        const operation = Promise.allSettled(stopping).then(() => undefined);
        this.stopInFlight = operation;
        try {
            await operation;
        } finally {
            if (this.stopInFlight === operation) this.stopInFlight = undefined;
        }
    }

    private async stopScheduler(): Promise<void> {
        if (!this.started && this.activeJobs.size === 0 && !this.tickInFlight) {
            return;
        }

        this.started = false;
        if (this.pollTimer !== undefined) {
            clearTimeout(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.removeExternalAbortListener?.();
        this.removeExternalAbortListener = undefined;
        const reason = new DOMException("Scheduler stopped", "AbortError");
        this.lifetimeController?.abort(reason);
        this.tickController?.abort(reason);
        for (const active of this.activeJobs.values()) active.controller.abort(reason);

        const active = [...this.activeJobs.values()].map((job) => job.promise);
        // A job may still be committing its running record, before activeJobs owns it.
        if (this.tickInFlight) active.push(this.tickInFlight);
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

        const linked = linkedAbortController(signal ?? this.lifetimeController?.signal);
        this.tickController = linked.controller;
        const run = this.runTick(now, linked.controller.signal);
        this.tickInFlight = run;
        try {
            await run;
        } finally {
            linked.dispose();
            if (this.tickController === linked.controller) this.tickController = undefined;
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

    async recoverInterruptedJobs(now = new Date(), signal?: AbortSignal): Promise<number> {
        signal?.throwIfAborted();
        const jobs = await this.jobs.list();
        let recovered = 0;
        for (const job of jobs) {
            signal?.throwIfAborted();
            if (job.status !== "running" || this.activeJobs.has(job.id)) continue;
            await this.jobs.update(job.id, latest => {
                signal?.throwIfAborted();
                if (latest.status !== "running" || this.activeJobs.has(job.id)
                    || latest.currentRunId !== job.currentRunId) return latest;
                recovered += 1;
                const error = Object.assign(new Error("The previous process stopped while this job was running."), { code: "INTERRUPTED" });
                if (!this.retryAllowed(latest, { reason: "recovery", error })) {
                    return this.withoutReplay(latest, now, unsafeReplayError(error, now));
                }
                return {
                    ...latest,
                    status: "retrying",
                    nextRun: now.toISOString(),
                    updatedAt: now.toISOString(),
                    currentRunId: undefined,
                    lastError: normalizeJobError(error, now, true),
                };
            });
        }
        return recovered;
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
                if (signal?.aborted) break;
                const index = cursor;
                cursor += 1;
                try {
                    await this.runJob(dueJobs[index]!, now, signal);
                } catch (error) {
                    errors.push(error);
                }
            }
        }));
        signal?.throwIfAborted();

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
        schedulerSignal?.throwIfAborted();
        if (
            current === undefined
            || (current.status !== "scheduled" && current.status !== "retrying")
            || current.nextRun === null
            || dateValue(current.nextRun) > now.getTime()
        ) {
            return;
        }

        // Old versions persisted retries (and shutdown requeues) without a safety gate.
        if (isReplayCandidate(current) && !this.retryAllowed(current, { reason: "pending-retry" })) {
            const blockedAt = new Date();
            const error = unsafeReplayError(new Error("A persisted occurrence was awaiting replay."), blockedAt);
            await this.jobs.update(current.id, latest => (
                latest.status === current.status && latest.nextRun === current.nextRun
                    && latest.currentRunId === current.currentRunId
                    ? this.withoutReplay(latest, blockedAt, error) : latest
            ));
            return;
        }

        const runId = createRunId();
        const startedAt = new Date().toISOString();
        const linked = linkedAbortController(schedulerSignal);
        // Own the claim before awaiting storage so cancel/stop can abort it too.
        const promise = Promise.resolve().then(async () => {
            let running: Job | undefined;
            await this.jobs.update(current.id, latest => {
                // get() was only a snapshot. Do not overwrite a later cancel/edit.
                if (latest.status !== current.status || latest.nextRun !== current.nextRun
                    || latest.currentRunId !== current.currentRunId || latest.attempts !== current.attempts) {
                    return latest;
                }
                if (linked.controller.signal.aborted) {
                    return this.cancellationRequests.has(current.id)
                        ? { ...latest, status: "cancelled", nextRun: null, currentRunId: undefined,
                            updatedAt: new Date().toISOString() }
                        : latest;
                }
                // An action edit after the snapshot must not bypass the replay policy.
                if (isReplayCandidate(latest) && !this.retryAllowed(latest, { reason: "pending-retry" })) {
                    const blockedAt = new Date();
                    return this.withoutReplay(latest, blockedAt,
                        unsafeReplayError(new Error("A persisted occurrence was awaiting replay."), blockedAt));
                }
                running = {
                    ...latest, status: "running", attempts: latest.attempts + 1,
                    lastRunAt: startedAt, updatedAt: startedAt, currentRunId: runId,
                };
                return running;
            });
            if (running) await this.executeRunningJob(running, runId, startedAt, linked.controller);
        })
            .finally(() => {
                linked.dispose();
                this.activeJobs.delete(current.id);
                this.cancellationRequests.delete(current.id);
            });
        this.activeJobs.set(current.id, {
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
            controller.signal.throwIfAborted();
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
        const at = new Date();
        const now = at.toISOString();
        const allowReplay = !cancelledByUser && this.retryAllowed(job, { reason: "shutdown" });
        await this.jobs.update(job.id, (latest) => {
            if (latest.currentRunId !== runId) {
                return latest;
            }
            if (!cancelledByUser && !allowReplay) {
                const error = Object.assign(new Error("The scheduler stopped during this occurrence."), { code: "SHUTDOWN_INTERRUPTED" });
                return this.withoutReplay(latest, at, unsafeReplayError(error, at));
            }
            return {
                ...latest,
                status: cancelledByUser ? "cancelled" : "scheduled",
                nextRun: cancelledByUser ? null : latest.nextRun,
                updatedAt: now,
                currentRunId: undefined,
                ...(cancelledByUser && this.canRetryJob ? {
                    lastError: {
                        message: "Cancelled by the user. Effects already accepted by an external service cannot be undone by cancellation.",
                        code: "USER_CANCELLED", at: now, retryable: false, outcome: "unknown" as const,
                    },
                } : {}),
            };
        });
    }

    private async saveFailure(job: Job, runId: RunId, error: unknown): Promise<void> {
        const failedAt = new Date();
        const nextRetryCount = job.retryCount + 1;
        const allowReplay = this.retryAllowed(job, { reason: "failure", error });
        const willRetry = allowReplay && nextRetryCount <= job.retryPolicy.maxRetries;
        const jobError = allowReplay
            ? normalizeJobError(error, failedAt, willRetry)
            : unsafeReplayError(error, failedAt);
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

    private retryAllowed(job: Job, context: JobRetryContext): boolean {
        if (!this.canRetryJob) return true;
        try {
            return this.canRetryJob(job, context) === true;
        } catch (error) {
            // A failing policy must never authorize side effects by accident.
            try { this.onError(error); } catch { /* Preserve the fail-closed decision. */ }
            return false;
        }
    }

    private withoutReplay(job: Job, at: Date, error: JobError): Job {
        const nextRun = this.nextRecurringRun(job, at);
        return {
            ...job,
            status: nextRun ? "scheduled" : "failed",
            nextRun: nextRun?.toISOString() ?? null,
            updatedAt: at.toISOString(),
            retryCount: nextRun ? 0 : job.retryCount,
            currentRunId: undefined,
            lastError: error,
            ...(job.currentRunId ? {
                lastResult: {
                    runId: job.currentRunId,
                    status: "failed" as const,
                    startedAt: job.lastRunAt ?? at.toISOString(),
                    finishedAt: at.toISOString(),
                },
            } : {}),
        };
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

function isReplayCandidate(job: Job): boolean {
    if (job.status === "retrying") return true;
    // Legacy shutdown used scheduled + the already-attempted nextRun.
    return job.status === "scheduled" && job.attempts > 0
        && job.nextRun !== null && job.lastRunAt !== undefined
        && dateValue(job.nextRun) <= dateValue(job.lastRunAt);
}

function unsafeReplayError(error: unknown, at: Date): JobError {
    const normalized = normalizeJobError(error, at, false);
    return {
        ...normalized,
        code: normalized.code ?? "UNSAFE_RETRY_BLOCKED",
        message: `${normalized.message} Execution outcome is uncertain; automatic replay was blocked to avoid duplicate effects.`,
        outcome: "unknown",
        retrySuppressed: true,
    };
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
