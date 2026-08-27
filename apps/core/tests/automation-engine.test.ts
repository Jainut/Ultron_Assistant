import assert from "node:assert/strict";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    ActionRunner,
    AtomicJsonStore,
    AutomationEngine,
    createActionId,
    createAutomationId,
    createJobId,
    createRunId,
    JobStore,
    Scheduler,
    TriggerEngine,
    type Job,
    type JsonObject,
    type TimeScheduleTrigger,
} from "../src/automation-engine/index.ts";

test("AtomicJsonStore serializa mutações e sobrevive a uma nova instância", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-automation-store-"));
    const storePath = path.join(temporaryRoot, "records.json");

    try {
        const store = new AtomicJsonStore<{ readonly id: string; readonly value: number }>(
            storePath,
        );
        await Promise.all(Array.from({ length: 12 }, (_, index) => (
            store.put({ id: `record-${index}`, value: index })
        )));
        await store.update("record-4", (record) => ({ ...record, value: 40 }));

        const restartedStore = new AtomicJsonStore<{
            readonly id: string;
            readonly value: number;
        }>(storePath);
        const records = await restartedStore.list();
        assert.equal(records.length, 12);
        assert.equal(records.find((record) => record.id === "record-4")?.value, 40);
        assert.equal(
            (await readdir(temporaryRoot)).some((entry) => entry.endsWith(".tmp")),
            false,
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("TriggerEngine calcula once, interval e daily com timezone", () => {
    const triggers = new TriggerEngine("America/Sao_Paulo");
    const once: TimeScheduleTrigger = {
        type: "time.schedule",
        config: {
            schedule: {
                kind: "once",
                at: "2026-08-20T15:00:00-03:00",
            },
        },
    };
    assert.equal(
        triggers.nextRun(once, new Date("2026-08-20T17:59:59Z"))?.toISOString(),
        "2026-08-20T18:00:00.000Z",
    );
    assert.equal(
        triggers.nextRun(once, new Date("2026-08-20T18:00:00Z")),
        null,
    );

    const interval: TimeScheduleTrigger = {
        type: "time.schedule",
        config: {
            schedule: {
                kind: "interval",
                everyMs: 60_000,
                startAt: "2026-08-20T18:00:00Z",
            },
        },
    };
    assert.equal(
        triggers.nextRun(interval, new Date("2026-08-20T18:02:30Z"))?.toISOString(),
        "2026-08-20T18:03:00.000Z",
    );

    const daily: TimeScheduleTrigger = {
        type: "time.schedule",
        config: {
            schedule: {
                kind: "daily",
                time: "08:00",
                timezone: "America/Sao_Paulo",
                daysOfWeek: [1, 2, 3, 4, 5],
            },
        },
    };
    assert.equal(
        triggers.nextRun(daily, new Date("2026-08-21T12:00:00Z"))?.toISOString(),
        "2026-08-24T11:00:00.000Z",
    );
});

test("ActionRunner preserva ordem e propaga AbortSignal", async () => {
    const runner = new ActionRunner();
    const order: number[] = [];
    runner.register<JsonObject, JsonObject>("test.step", async (input, context) => {
        const value = Number(input.value);
        order.push(value);
        assert.equal(context.previousResults.length, value - 1);
        return { value };
    });

    const context = {
        automationId: createAutomationId(),
        jobId: createJobId(),
        runId: createRunId(),
    };
    const result = await runner.execute([
        { id: createActionId(), type: "test.step", input: { value: 1 } },
        { id: createActionId(), type: "test.step", input: { value: 2 } },
    ], context);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(order, [1, 2]);

    runner.register<JsonObject, JsonObject>("test.abort", async (_input, actionContext) => {
        await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(
                actionContext.signal?.reason
                    ?? new DOMException("Aborted", "AbortError"),
            );
            actionContext.signal?.addEventListener("abort", abort, { once: true });
        });
        return {};
    });
    const controller = new AbortController();
    const aborted = runner.execute([
        { id: createActionId(), type: "test.abort", input: {} },
    ], { ...context, signal: controller.signal });
    controller.abort(new DOMException("Interrompido", "AbortError"));
    await assert.rejects(aborted, (error: Error) => error.name === "AbortError");
});

test("Scheduler persiste retry/backoff e conclui após reinício lógico", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-scheduler-"));
    const jobPath = path.join(temporaryRoot, "jobs.json");

    try {
        const jobs = new JobStore(jobPath);
        const dueAt = new Date(Date.now() - 1_000).toISOString();
        const job = makeJob(dueAt);
        await jobs.put(job);

        let executions = 0;
        const scheduler = new Scheduler(
            jobs,
            new TriggerEngine("UTC"),
            async (_scheduledJob, context) => {
                context.signal.throwIfAborted();
                executions += 1;
                return executions === 1
                    ? { status: "failed", error: "temporary provider failure" }
                    : { status: "succeeded" };
            },
            { pollIntervalMs: 60_000 },
        );

        await scheduler.tick(new Date());
        const retrying = await jobs.get(job.id);
        assert.equal(retrying?.status, "retrying");
        assert.equal(retrying?.retryCount, 1);
        assert.match(retrying?.lastError?.message ?? "", /temporary provider failure/);
        assert.ok(retrying?.nextRun);

        // A fresh store instance models state reloaded by a restarted process.
        const restartedJobs = new JobStore(jobPath);
        const restartedScheduler = new Scheduler(
            restartedJobs,
            new TriggerEngine("UTC"),
            async (_scheduledJob, context) => {
                context.signal.throwIfAborted();
                executions += 1;
                return { status: "succeeded" };
            },
            { pollIntervalMs: 60_000 },
        );
        await restartedScheduler.tick(
            new Date(Date.parse(retrying!.nextRun!) + 1),
        );
        const completed = await restartedJobs.get(job.id);
        assert.equal(completed?.status, "completed");
        assert.equal(completed?.attempts, 2);
        assert.equal(completed?.retryCount, 0);
        assert.equal(completed?.lastResult?.status, "succeeded");
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("Scheduler avança interval após esgotar retries e mantém a falha através de restart", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-recurring-retry-"));
    const jobPath = path.join(temporaryRoot, "jobs.json");

    try {
        const jobs = new JobStore(jobPath);
        const dueAt = new Date(Date.now() - 10).toISOString();
        const job: Job = {
            ...makeJob(dueAt),
            trigger: {
                type: "time.schedule",
                config: {
                    schedule: {
                        kind: "interval",
                        everyMs: 50,
                        startAt: dueAt,
                    },
                },
            },
            retryPolicy: {
                maxRetries: 0,
                baseDelayMs: 1,
                multiplier: 2,
                maxDelayMs: 10,
            },
        };
        await jobs.put(job);
        const scheduler = new Scheduler(
            jobs,
            new TriggerEngine("UTC"),
            async () => ({ status: "failed", error: "provider offline" }),
            { pollIntervalMs: 60_000 },
        );

        await scheduler.tick(new Date());
        const advanced = await jobs.get(job.id);
        assert.equal(advanced?.status, "scheduled");
        assert.equal(advanced?.retryCount, 0);
        assert.equal(advanced?.attempts, 1);
        assert.equal(advanced?.lastResult?.status, "failed");
        assert.match(advanced?.lastError?.message ?? "", /provider offline/);
        assert.equal(advanced?.lastError?.retryable, false);
        assert.ok(advanced?.nextRun);
        assert.ok(Date.parse(advanced!.nextRun!) > Date.parse(advanced!.lastError!.at));

        // Uma nova store/scheduler modela o restart real do processo.
        const restartedJobs = new JobStore(jobPath);
        const persisted = await restartedJobs.get(job.id);
        assert.equal(persisted?.status, "scheduled");
        assert.equal(persisted?.nextRun, advanced?.nextRun);
        assert.equal(persisted?.lastResult?.status, "failed");

        const waitMs = Math.max(0, Date.parse(persisted!.nextRun!) - Date.now() + 5);
        await new Promise<void>(resolve => setTimeout(resolve, waitMs));
        const restartedScheduler = new Scheduler(
            restartedJobs,
            new TriggerEngine("UTC"),
            async () => ({ status: "succeeded" }),
            { pollIntervalMs: 60_000 },
        );
        await restartedScheduler.tick(new Date());
        const succeeded = await restartedJobs.get(job.id);
        assert.equal(succeeded?.status, "scheduled");
        assert.equal(succeeded?.attempts, 2);
        assert.equal(succeeded?.retryCount, 0);
        assert.equal(succeeded?.lastResult?.status, "succeeded");
        assert.equal(succeeded?.lastError, undefined);
        // Compare persisted event times, not a 5 ms wall-clock window: disk I/O
        // and other test workers may legitimately outlive the 50 ms interval.
        assert.ok(Date.parse(succeeded!.nextRun!) > Date.parse(succeeded!.lastCompletedAt!));
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("Scheduler persiste próxima ocorrência daily após falha definitiva da ocorrência", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-daily-retry-"));
    const jobPath = path.join(temporaryRoot, "jobs.json");

    try {
        const jobs = new JobStore(jobPath);
        const dueAt = new Date(Date.now() - 1_000).toISOString();
        const pastClock = new Date(Date.now() - 60_000);
        const time = [
            pastClock.getUTCHours(),
            pastClock.getUTCMinutes(),
            pastClock.getUTCSeconds(),
        ].map(value => String(value).padStart(2, "0")).join(":");
        const job: Job = {
            ...makeJob(dueAt),
            trigger: {
                type: "time.schedule",
                config: {
                    schedule: { kind: "daily", time, timezone: "UTC" },
                },
            },
            retryPolicy: {
                maxRetries: 0,
                baseDelayMs: 1,
                multiplier: 2,
                maxDelayMs: 10,
            },
        };
        await jobs.put(job);
        const scheduler = new Scheduler(
            jobs,
            new TriggerEngine("UTC"),
            async () => ({ status: "failed", error: "daily delivery failed" }),
        );

        await scheduler.tick(new Date());
        const advanced = await jobs.get(job.id);
        assert.equal(advanced?.status, "scheduled");
        assert.equal(advanced?.retryCount, 0);
        assert.equal(advanced?.lastResult?.status, "failed");
        assert.ok(advanced?.nextRun);
        assert.ok(Date.parse(advanced!.nextRun!) > Date.parse(advanced!.lastError!.at));
        assert.ok(Date.parse(advanced!.nextRun!) - Date.now() <= 24 * 60 * 60 * 1_000);

        const restartedJobs = new JobStore(jobPath);
        const persisted = await restartedJobs.get(job.id);
        assert.equal(persisted?.nextRun, advanced?.nextRun);
        assert.equal(persisted?.lastError?.message, "daily delivery failed");
        assert.equal(persisted?.lastError?.retryable, false);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("Scheduler mantém once e trigger não recorrente terminais ao esgotar retries", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-terminal-retry-"));

    try {
        const jobs = new JobStore(path.join(temporaryRoot, "jobs.json"));
        const dueAt = new Date(Date.now() - 1_000).toISOString();
        const once: Job = {
            ...makeJob(dueAt),
            retryPolicy: {
                maxRetries: 0,
                baseDelayMs: 1,
                multiplier: 2,
                maxDelayMs: 10,
            },
        };
        const manual: Job = {
            ...makeJob(dueAt),
            id: createJobId(),
            trigger: { type: "automation.manual", config: {} },
            retryPolicy: once.retryPolicy,
        };
        await jobs.putMany([once, manual]);
        const scheduler = new Scheduler(
            jobs,
            new TriggerEngine("UTC"),
            async () => ({ status: "failed", error: "terminal failure" }),
        );

        await scheduler.tick(new Date());
        for (const persisted of await jobs.list()) {
            assert.equal(persisted.status, "failed");
            assert.equal(persisted.nextRun, null);
            assert.equal(persisted.retryCount, 1);
            assert.equal(persisted.lastResult?.status, "failed");
        }
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("Scheduler recupera job que estava running durante uma queda", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-recovery-"));

    try {
        const jobs = new JobStore(path.join(temporaryRoot, "jobs.json"));
        const interrupted: Job = {
            ...makeJob(new Date().toISOString()),
            status: "running",
            currentRunId: createRunId(),
            attempts: 1,
        };
        await jobs.put(interrupted);
        const scheduler = new Scheduler(
            jobs,
            new TriggerEngine(),
            async () => ({ status: "succeeded" }),
        );
        const recovered = await scheduler.recoverInterruptedJobs(new Date());
        const persisted = await jobs.get(interrupted.id);

        assert.equal(recovered, 1);
        assert.equal(persisted?.status, "retrying");
        assert.equal(persisted?.currentRunId, undefined);
        assert.equal(persisted?.lastError?.code, "INTERRUPTED");
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("AutomationEngine executa system.startup e mantém definição persistida", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-engine-"));

    try {
        let receivedSignal: AbortSignal | undefined;
        const engine = new AutomationEngine({
            storageDirectory: temporaryRoot,
            pollIntervalMs: 60_000,
            defaultTimezone: "America/Sao_Paulo",
        });
        engine.actions.register<JsonObject, JsonObject>(
            "notification.test",
            async (input, context) => {
                receivedSignal = context.signal;
                return { delivered: true, text: input.text ?? null };
            },
        );
        const automation = await engine.createAutomation({
            name: "Aviso de inicialização",
            trigger: { type: "system.startup", config: {} },
            conditions: [{ type: "always", parameters: {} }],
            actions: [{
                type: "notification.test",
                input: { text: "Ultron iniciado" },
            }],
        });

        await engine.start();
        await engine.stop();

        const persistedJobs = await engine.jobs.list();
        assert.equal(persistedJobs.length, 1);
        assert.equal(persistedJobs[0]?.automationId, automation.id);
        assert.equal(persistedJobs[0]?.status, "completed");
        assert.equal(receivedSignal?.aborted, false);

        const restartedEngine = new AutomationEngine({
            storageDirectory: temporaryRoot,
        });
        assert.equal((await restartedEngine.listAutomations())[0]?.name, automation.name);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

function makeJob(nextRun: string): Job {
    const now = new Date().toISOString();
    return {
        id: createJobId(),
        automationId: createAutomationId(),
        trigger: {
            type: "time.schedule",
            config: {
                schedule: {
                    kind: "once",
                    at: nextRun,
                },
            },
        },
        conditions: [],
        actions: [],
        status: "scheduled",
        timezone: "UTC",
        nextRun,
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        retryCount: 0,
        retryPolicy: {
            maxRetries: 2,
            baseDelayMs: 5,
            multiplier: 2,
            maxDelayMs: 100,
        },
    };
}
