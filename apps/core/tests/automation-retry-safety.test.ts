import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate, setTimeout as delay } from "node:timers/promises";

import { AutomationEngine } from "../src/automation-engine/automation-engine.ts";
import { createActionId, createAutomationId, createJobId, createRunId } from "../src/automation-engine/ids.ts";
import { canRetryAutomationJob } from "../src/automation-engine/runtime.ts";
import { Scheduler } from "../src/automation-engine/scheduler.ts";
import { JobStore } from "../src/automation-engine/stores.ts";
import { TriggerEngine } from "../src/automation-engine/trigger-engine.ts";
import { ServiceSupervisor } from "../src/system/service-supervisor.ts";
import type { Job, JsonValue } from "../src/automation-engine/types.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function fixture(t: TestContext) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-retry-safety-"));
    const cleanup: Array<() => Promise<unknown>> = [];
    t.after(async () => {
        for (const close of cleanup) await close();
        const target = path.resolve(directory);
        assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
        assert.ok(path.basename(target).startsWith("ultron-retry-safety-"));
        await rm(target, { recursive: true, force: true });
    });
    return { directory, jobs: new JobStore(path.join(directory, "jobs.json")), cleanup };
}

function makeJob(type: string, input: JsonValue = {}, overrides: Partial<Job> = {}): Job {
    const at = new Date(Date.now() - 1_000).toISOString();
    return {
        id: createJobId(), automationId: createAutomationId(),
        trigger: { type: "time.schedule", config: { schedule: { kind: "once", at } } },
        conditions: [], actions: [{ id: createActionId(), type, input }],
        status: "scheduled", timezone: "UTC", nextRun: at, createdAt: at, updatedAt: at,
        attempts: 0, retryCount: 0,
        retryPolicy: { maxRetries: 3, baseDelayMs: 5, multiplier: 2, maxDelayMs: 100 },
        ...overrides,
    };
}

function recurring(job: Job, everyMs = 60_000): Job {
    return { ...job, trigger: { type: "time.schedule", config: { schedule: {
        kind: "interval", startAt: job.nextRun!, everyMs,
    } } } };
}

function abortable(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    });
}

test("policy runtime permite leitura revisada, não usa categoria read para autorizar mutações", () => {
    for (const type of ["mail.list", "mail.search", "mail.read", "mail.thread", "task.get", "task.search",
        "calendar.list", "calendar.checkConflicts", "notification.list", "list_directory", "get_current_time"]) {
        assert.equal(canRetryAutomationJob(makeJob(type)), true, type);
    }
    for (const type of ["mail.send", "mail.createDraft", "task.create", "task.update", "calendar.create",
        "open_application", "open_file", "change_directory", "create_directory", "custom.readAnything"]) {
        assert.equal(canRetryAutomationJob(makeJob(type)), false, type);
    }
    for (const type of ["control_tv", "control_light", "control_home_device"]) {
        assert.equal(canRetryAutomationJob(makeJob(type, { action: "status" })), true);
        for (const action of ["toggle", "on", "off", "volume_up", "mute"]) {
            assert.equal(canRetryAutomationJob(makeJob(type, { action })), false, `${type}:${action}`);
        }
    }
    const batch = makeJob("mail.list");
    assert.equal(canRetryAutomationJob({ ...batch, actions: [...batch.actions, ...makeJob("mail.send").actions] }), false);
    assert.equal(canRetryAutomationJob({ ...batch, actions: [] }), false);
});

test("monitors deduplicados e briefing com at absoluto podem repetir, publicação relativa não", () => {
    assert.equal(canRetryAutomationJob(makeJob("mail.watch", { watchId: "watch-1" })), true);
    assert.equal(canRetryAutomationJob(makeJob("mail.watch", { watchId: " " })), false);
    assert.equal(canRetryAutomationJob(makeJob("calendar.reminderScan", { reminderId: "reminder-1", leadMinutes: 10 })), true);
    assert.equal(canRetryAutomationJob(makeJob("calendar.reminderScan", {})), false);
    assert.equal(canRetryAutomationJob(makeJob("personal.dailyBriefing", {})), true);
    assert.equal(canRetryAutomationJob(makeJob("personal.dailyBriefing", { publishNotification: false })), true);
    assert.equal(canRetryAutomationJob(makeJob("personal.dailyBriefing", { publishNotification: true })), false);
    assert.equal(canRetryAutomationJob(makeJob("personal.dailyBriefing", { publishNotification: true, at: "2026-08-27" })), false);
    assert.equal(canRetryAutomationJob(makeJob("personal.dailyBriefing", { publishNotification: true, at: "2026-08-27T12:00:00Z" })), true);
});

test("falha após envio incerto fica terminal e persistida sem novo envio", async t => {
    const { directory, jobs } = await fixture(t);
    const job = makeJob("mail.send");
    await jobs.put(job);
    let sends = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => {
        sends += 1;
        return { status: "failed", error: "Connection lost after the provider accepted the message" };
    }, { canRetryJob: canRetryAutomationJob });
    await scheduler.tick();
    await scheduler.tick(new Date(Date.now() + 60_000));
    const saved = await new JobStore(path.join(directory, "jobs.json")).get(job.id);
    assert.equal(sends, 1);
    assert.equal(saved?.status, "failed");
    assert.equal(saved?.nextRun, null);
    assert.equal(saved?.lastError?.retryable, false);
    assert.equal(saved?.lastError?.retrySuppressed, true);
    assert.equal(saved?.lastError?.outcome, "unknown");
    assert.match(saved?.lastError?.message ?? "", /uncertain/);
});

test("batch parcialmente concluído não reenvia mutação quando uma leitura posterior falha", async t => {
    const { directory, cleanup } = await fixture(t);
    const engine = new AutomationEngine({ storageDirectory: directory, canRetryJob: canRetryAutomationJob });
    cleanup.push(() => engine.stop());
    let sends = 0;
    engine.actions.register("mail.send", () => { sends += 1; return {}; });
    engine.actions.register("task.list", () => { throw new Error("read timeout"); });
    const automation = await engine.createAutomation({
        name: "Fixture batch", trigger: { type: "automation.manual", config: {} },
        actions: [{ type: "mail.send", input: {} }, { type: "task.list", input: {} }],
    });
    const job = await engine.runNow(automation.id);
    await engine.scheduler.tick();
    await engine.scheduler.tick(new Date(Date.now() + 60_000));
    assert.equal(sends, 1);
    assert.equal((await engine.jobs.get(job.id))?.status, "failed");
});

test("leitura mantém backoff e retry existentes com policy runtime", async t => {
    const { jobs } = await fixture(t);
    const job = makeJob("task.list");
    await jobs.put(job);
    let reads = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => (
        ++reads === 1 ? { status: "failed", error: "temporary read failure" } : { status: "succeeded" }
    ), { canRetryJob: canRetryAutomationJob });
    await scheduler.tick();
    const retry = await jobs.get(job.id);
    assert.equal(retry?.status, "retrying");
    assert.equal(retry?.retryCount, 1);
    assert.equal(retry?.lastError?.retryable, true);
    await scheduler.tick(new Date(Date.parse(retry!.nextRun!) + 1));
    assert.equal(reads, 2);
    assert.equal((await jobs.get(job.id))?.status, "completed");
});

test("recorrência mutante falha só a ocorrência incerta e continua no próximo horário", async t => {
    const { jobs } = await fixture(t);
    const job = recurring(makeJob("task.create"), 200);
    await jobs.put(job);
    let writes = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => (
        ++writes === 1 ? { status: "failed", error: "write outcome unknown" } : { status: "succeeded" }
    ), { canRetryJob: canRetryAutomationJob });
    await scheduler.tick();
    const next = await jobs.get(job.id);
    assert.equal(next?.status, "scheduled");
    assert.equal(next?.retryCount, 0);
    assert.equal(next?.lastResult?.status, "failed");
    assert.equal(next?.lastError?.retrySuppressed, true);
    assert.ok(Date.parse(next!.nextRun!) > Date.parse(next!.lastError!.at));
    await scheduler.tick(new Date(Date.parse(next!.lastError!.at)));
    assert.equal(writes, 1);
    await delay(Math.max(0, Date.parse(next!.nextRun!) - Date.now() + 1));
    await scheduler.tick();
    assert.equal(writes, 2);
    assert.equal((await jobs.get(job.id))?.lastResult?.status, "succeeded");
});

test("recovery recusa running mutante mas mantém recovery da leitura", async t => {
    const { jobs } = await fixture(t);
    const at = new Date().toISOString();
    const mutating = ["mail.send", "task.create", "control_tv"].map(type => makeJob(type, { action: "toggle" }, {
        status: "running", currentRunId: createRunId(), attempts: 1, lastRunAt: at,
    }));
    const read = makeJob("mail.list", {}, { status: "running", currentRunId: createRunId(), attempts: 1, lastRunAt: at });
    await jobs.putMany([...mutating, read]);
    const executed: string[] = [];
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async job => {
        executed.push(job.actions[0]!.type);
        return { status: "succeeded" };
    }, { canRetryJob: canRetryAutomationJob });
    assert.equal(await scheduler.recoverInterruptedJobs(), 4);
    for (const old of mutating) {
        const saved = await jobs.get(old.id);
        assert.equal(saved?.status, "failed");
        assert.equal(saved?.lastError?.code, "INTERRUPTED");
        assert.equal(saved?.lastError?.outcome, "unknown");
        assert.equal(saved?.lastResult?.status, "failed");
    }
    assert.equal((await jobs.get(read.id))?.status, "retrying");
    await scheduler.tick();
    assert.deepEqual(executed, ["mail.list"]);
});

test("recovery de recorrência desconhecida preserva próxima ocorrência sem replay imediato", async t => {
    const { jobs } = await fixture(t);
    const job = recurring(makeJob("plugin.unknown", {}, {
        status: "running", attempts: 1, lastRunAt: new Date().toISOString(), currentRunId: createRunId(),
    }));
    await jobs.put(job);
    let calls = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => { calls += 1; return { status: "succeeded" }; },
        { canRetryJob: canRetryAutomationJob });
    await scheduler.recoverInterruptedJobs();
    const saved = await jobs.get(job.id);
    assert.equal(saved?.status, "scheduled");
    assert.ok(Date.parse(saved!.nextRun!) > Date.parse(saved!.lastError!.at));
    await scheduler.tick();
    assert.equal(calls, 0);
});

test("retrying legado e requeue scheduled antigo não contornam a nova policy", async t => {
    const { jobs } = await fixture(t);
    const retrying = makeJob("task.create", {}, { status: "retrying", attempts: 1, retryCount: 1 });
    const shutdownRequeue = makeJob("mail.send", {}, { attempts: 1, lastRunAt: new Date().toISOString() });
    await jobs.putMany([retrying, shutdownRequeue]);
    let calls = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => { calls += 1; return { status: "succeeded" }; },
        { canRetryJob: canRetryAutomationJob });
    await scheduler.tick();
    assert.equal(calls, 0);
    for (const saved of await jobs.list()) {
        assert.equal(saved.status, "failed");
        assert.equal(saved.lastError?.retrySuppressed, true);
    }
});

test("shutdown não reabre nextRun antigo de mutação em voo", async t => {
    const { jobs, cleanup } = await fixture(t);
    const job = makeJob("mail.send");
    await jobs.put(job);
    const entered = deferred();
    let calls = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async (_job, context) => {
        calls += 1; entered.resolve();
        return abortable(context.signal);
    }, { canRetryJob: canRetryAutomationJob });
    cleanup.push(() => scheduler.stop());
    const running = assert.rejects(scheduler.tick(), { name: "AbortError" });
    await entered.promise;
    await scheduler.stop();
    await running;
    const stopped = await jobs.get(job.id);
    assert.equal(stopped?.status, "failed");
    assert.equal(stopped?.nextRun, null);
    assert.equal(stopped?.lastError?.code, "SHUTDOWN_INTERRUPTED");
    assert.equal(stopped?.lastError?.retrySuppressed, true);
    await scheduler.tick();
    assert.equal(calls, 1);
});

test("shutdown conserva requeue de leitura autorizada", async t => {
    const { jobs, cleanup } = await fixture(t);
    const job = makeJob("task.list");
    await jobs.put(job);
    const entered = deferred();
    let calls = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async (_job, context) => {
        calls += 1;
        if (calls > 1) return { status: "succeeded" };
        entered.resolve();
        return abortable(context.signal);
    }, { canRetryJob: canRetryAutomationJob });
    cleanup.push(() => scheduler.stop());
    const running = assert.rejects(scheduler.tick(), { name: "AbortError" });
    await entered.promise;
    await scheduler.stop();
    await running;
    assert.equal((await jobs.get(job.id))?.status, "scheduled");
    await scheduler.tick();
    assert.equal(calls, 2);
    assert.equal((await jobs.get(job.id))?.status, "completed");
});

test("cancelamento explícito permanece terminal inclusive para recorrência", async t => {
    const { jobs, cleanup } = await fixture(t);
    const job = recurring(makeJob("mail.send"));
    await jobs.put(job);
    const entered = deferred();
    let calls = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async (_job, context) => {
        calls += 1; entered.resolve();
        return abortable(context.signal);
    }, { canRetryJob: canRetryAutomationJob });
    cleanup.push(() => scheduler.stop());
    const running = scheduler.tick();
    await entered.promise;
    assert.equal(await scheduler.cancel(job.id), true);
    await running;
    const saved = await jobs.get(job.id);
    assert.equal(saved?.status, "cancelled");
    assert.equal(saved?.nextRun, null);
    assert.equal(saved?.lastError?.outcome, "unknown");
    await scheduler.tick(new Date(Date.now() + 120_000));
    assert.equal(calls, 1);
});

test("shutdown durante commit running drena tick e não inicia executor atrasado", async t => {
    const { jobs, cleanup } = await fixture(t);
    const job = makeJob("task.create");
    await jobs.put(job);
    const committing = deferred(), release = deferred();
    const update = jobs.update.bind(jobs);
    jobs.update = async (id, updater) => {
        const record = await update(id, updater);
        if (record?.status === "running") { committing.resolve(); await release.promise; }
        return record;
    };
    let calls = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => { calls += 1; return { status: "succeeded" }; },
        { canRetryJob: canRetryAutomationJob });
    cleanup.push(async () => { release.resolve(); await scheduler.stop(); });
    const running = assert.rejects(scheduler.tick(), { name: "AbortError" });
    await committing.promise;
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await setImmediate();
    assert.equal(stopped, false);
    release.resolve();
    await stopping;
    await running;
    assert.equal(calls, 0);
    assert.equal((await jobs.get(job.id))?.status, "failed");
});

test("recovery não reaproveita job ainda possuído por um executor ativo", async t => {
    const { jobs, cleanup } = await fixture(t);
    const job = makeJob("mail.send");
    await jobs.put(job);
    const entered = deferred(), release = deferred();
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => {
        entered.resolve(); await release.promise; return { status: "succeeded" };
    }, { canRetryJob: canRetryAutomationJob });
    cleanup.push(async () => { release.resolve(); await scheduler.stop(); });
    const running = scheduler.tick();
    await entered.promise;
    assert.equal(await scheduler.recoverInterruptedJobs(), 0);
    assert.equal((await jobs.get(job.id))?.status, "running");
    release.resolve();
    await running;
    assert.equal((await jobs.get(job.id))?.status, "completed");
});

test("falha da própria policy fecha a autorização e não repete a ação", async t => {
    const { jobs } = await fixture(t);
    const job = makeJob("task.create");
    await jobs.put(job);
    let errors = 0, calls = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => {
        calls += 1; return { status: "failed", error: "uncertain provider result" };
    }, { canRetryJob: () => { throw new Error("policy unavailable"); }, onError: () => { errors += 1; } });
    await scheduler.tick();
    await scheduler.tick(new Date(Date.now() + 60_000));
    assert.equal(calls, 1);
    assert.equal(errors, 1);
    assert.equal((await jobs.get(job.id))?.lastError?.retrySuppressed, true);
});

test("restart interno do mesmo Engine não redispara system.startup nem perde handlers", async t => {
    const { directory, cleanup } = await fixture(t);
    const options = { storageDirectory: directory, pollIntervalMs: 60_000, canRetryJob: canRetryAutomationJob };
    const engine = new AutomationEngine(options);
    cleanup.push(() => engine.stop());
    let sends = 0;
    engine.actions.register("mail.send", () => { sends += 1; return {}; });
    await engine.createAutomation({ name: "Startup fixture", trigger: { type: "system.startup", config: {} },
        actions: [{ type: "mail.send", input: {} }] });
    await engine.start();
    await engine.stop();
    await engine.start();
    await engine.stop();
    assert.equal(sends, 1);
    assert.equal((await engine.jobs.list()).length, 1);
    assert.equal(engine.actions.has("mail.send"), true);
    // A different engine models an actual application start, not a supervisor restart.
    const nextProcess = new AutomationEngine(options);
    cleanup.push(() => nextProcess.stop());
    nextProcess.actions.register("mail.send", () => { sends += 1; return {}; });
    await nextProcess.start();
    await nextProcess.stop();
    assert.equal(sends, 2);
});

test("dispatch startup parcialmente persistido reutiliza evento e não duplica job já concluído", async t => {
    const { directory, cleanup } = await fixture(t);
    const engine = new AutomationEngine({ storageDirectory: directory, pollIntervalMs: 60_000, canRetryJob: canRetryAutomationJob });
    cleanup.push(() => engine.stop());
    let sends = 0;
    engine.actions.register("mail.send", () => { sends += 1; return {}; });
    for (const name of ["first", "second"]) await engine.createAutomation({
        name, trigger: { type: "system.startup", config: {} }, actions: [{ type: "mail.send", input: {} }],
    });
    const put = engine.jobs.put.bind(engine.jobs);
    let dispatchWrites = 0;
    engine.jobs.put = async record => {
        if (record.status === "scheduled" && ++dispatchWrites === 2) throw new Error("fixture write failure");
        return put(record);
    };
    await assert.rejects(engine.start(), /fixture write failure/);
    engine.jobs.put = put;
    await engine.scheduler.tick();
    assert.equal(sends, 1);
    await engine.start();
    await engine.stop();
    assert.equal(sends, 2);
    assert.equal((await engine.jobs.list()).length, 2);
});

test("stop durante recovery inicial impede startup tardio e permite reinício limpo", async t => {
    const { directory, cleanup } = await fixture(t);
    const engine = new AutomationEngine({ storageDirectory: directory, pollIntervalMs: 60_000, canRetryJob: canRetryAutomationJob });
    const entered = deferred(), release = deferred();
    cleanup.push(async () => { release.resolve(); await engine.stop(); });
    let calls = 0;
    engine.actions.register("mail.send", () => { calls += 1; return {}; });
    await engine.createAutomation({ name: "Startup fixture", trigger: { type: "system.startup", config: {} }, actions: [{ type: "mail.send", input: {} }] });
    const list = engine.jobs.list.bind(engine.jobs);
    let first = true;
    engine.jobs.list = async () => {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return list();
    };
    const starting = assert.rejects(engine.start(), { name: "AbortError" });
    await entered.promise;
    const stopping = engine.stop();
    release.resolve();
    await stopping;
    await starting;
    assert.equal(calls, 0);
    assert.equal(engine.scheduler.isRunning, false);
    assert.equal((await engine.jobs.list()).length, 0);
    await engine.start();
    await engine.stop();
    assert.equal(calls, 1);
});

test("Scheduler direto serializa stop/start durante recovery sem encerrar a nova geração", async t => {
    const { jobs, cleanup } = await fixture(t);
    await jobs.put(makeJob("mail.send"));
    const entered = deferred(), release = deferred();
    const list = jobs.list.bind(jobs);
    let first = true, calls = 0;
    jobs.list = async () => {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return list();
    };
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => {
        calls += 1; return { status: "succeeded" };
    }, { canRetryJob: canRetryAutomationJob, pollIntervalMs: 60_000 });
    cleanup.push(async () => { release.resolve(); await scheduler.stop(); });
    const firstStart = assert.rejects(scheduler.start(), { name: "AbortError" });
    await entered.promise;
    const stopping = scheduler.stop();
    const restarting = scheduler.start();
    release.resolve();
    await stopping;
    await firstStart;
    await restarting;
    assert.equal(scheduler.isRunning, true);
    assert.equal(calls, 1);
    await scheduler.stop();
});

test("awaitInitialTick omitido preserva start aguardando a primeira execução", async t => {
    const { jobs, cleanup } = await fixture(t);
    await jobs.put(makeJob("mail.send"));
    const entered = deferred(), release = deferred();
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => {
        entered.resolve(); await release.promise; return { status: "succeeded" };
    }, { pollIntervalMs: 60_000 });
    cleanup.push(async () => { release.resolve(); await scheduler.stop(); });
    let ready = false;
    const starting = scheduler.start().then(() => { ready = true; });
    await entered.promise;
    await setImmediate();
    assert.equal(ready, false);
    release.resolve();
    await starting;
    assert.equal(ready, true);
});

test("supervisor considera engine pronto sem aguardar tool lenta e não sobrepõe ticks", async t => {
    const { directory, cleanup } = await fixture(t);
    const engine = new AutomationEngine({ storageDirectory: directory, pollIntervalMs: 10,
        canRetryJob: canRetryAutomationJob, awaitInitialTick: false });
    await engine.createAutomation({ name: "Slow startup fixture", trigger: { type: "system.startup", config: {} },
        actions: [{ type: "mail.send", input: {} }] });
    // Keep the short supervisor deadline deterministic: startup/store work here
    // is in-memory while the real action remains pending longer than its timeout.
    const automations = await engine.automations.list();
    engine.automations.list = async () => structuredClone(automations);
    const records = new Map<string, Job>();
    engine.jobs.list = async () => [...records.values()].map(record => structuredClone(record));
    engine.jobs.get = async id => structuredClone(records.get(id));
    engine.jobs.put = async record => { records.set(record.id, structuredClone(record)); return record; };
    engine.jobs.update = async (id, update) => {
        const current = records.get(id);
        if (!current) return undefined;
        const next = update(structuredClone(current));
        records.set(id, structuredClone(next));
        return next;
    };
    const entered = deferred();
    let sends = 0, ticks = 0;
    engine.actions.register("mail.send", async (_input, context) => {
        sends += 1; entered.resolve(); return abortable(context.signal!);
    });
    const tick = engine.scheduler.tick.bind(engine.scheduler);
    engine.scheduler.tick = async (...args) => { ticks += 1; await tick(...args); };
    const supervisor = new ServiceSupervisor();
    cleanup.push(() => supervisor.stopAll());
    supervisor.register({ name: "automation", start: signal => engine.start(signal), stop: () => engine.stop(),
        health: () => engine.scheduler.isRunning,
        policy: { startupTimeoutMs: 25, stopTimeoutMs: 500, maxRestarts: 1, backoffMs: 0, healthIntervalMs: 0 } });
    await supervisor.start("automation");
    await entered.promise;
    await delay(50);
    assert.equal(supervisor.snapshot("automation").state, "ready");
    assert.equal(supervisor.snapshot("automation").restarts, 0);
    assert.equal(engine.scheduler.isRunning, true);
    assert.equal(sends, 1);
    assert.equal(ticks, 1);
    await supervisor.stop("automation");
    assert.equal((await engine.jobs.list())[0]?.status, "failed");
    await supervisor.start("automation");
    assert.equal(sends, 1);
    assert.equal((await engine.jobs.list()).length, 1);
});

test("primeiro tick em background observa erro de persistência sem rejection solta", async t => {
    const { jobs, cleanup } = await fixture(t);
    await jobs.put(makeJob("task.list"));
    const reported = deferred();
    jobs.update = async () => { throw new Error("fixture store offline"); };
    let calls = 0, errors = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => {
        calls += 1; return { status: "succeeded" };
    }, { awaitInitialTick: false, pollIntervalMs: 60_000, onError: error => {
        assert.match((error as Error).message, /fixture store offline/);
        errors += 1; reported.resolve();
    } });
    cleanup.push(() => scheduler.stop());
    await scheduler.start();
    await reported.promise;
    assert.equal(scheduler.isRunning, true);
    assert.equal(calls, 0);
    assert.equal(errors, 1);
});

test("cancel entre snapshot e claim não é sobrescrito nem envia mail.send", async t => {
    const { jobs, cleanup } = await fixture(t);
    const job = makeJob("mail.send");
    await jobs.put(job);
    const entered = deferred(), release = deferred();
    const get = jobs.get.bind(jobs);
    let first = true;
    jobs.get = async id => {
        const snapshot = await get(id);
        if (id === job.id && first) { first = false; entered.resolve(); await release.promise; }
        return snapshot;
    };
    let sends = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => {
        sends += 1; return { status: "succeeded" };
    }, { canRetryJob: canRetryAutomationJob });
    cleanup.push(async () => { release.resolve(); await scheduler.stop(); });
    const running = scheduler.tick();
    await entered.promise;
    assert.equal(await scheduler.cancel(job.id), true);
    assert.equal((await get(job.id))?.status, "cancelled");
    release.resolve();
    await running;
    assert.equal(sends, 0);
    assert.equal((await get(job.id))?.status, "cancelled");
    assert.equal((await get(job.id))?.attempts, 0);
});

test("cancel durante claim reservado aborta antes do executor e persiste cancelled", async t => {
    const { jobs, cleanup } = await fixture(t);
    const job = makeJob("mail.send");
    await jobs.put(job);
    const entered = deferred(), release = deferred();
    const update = jobs.update.bind(jobs);
    let first = true;
    jobs.update = async (id, updater) => {
        if (id === job.id && first) { first = false; entered.resolve(); await release.promise; }
        return update(id, updater);
    };
    let sends = 0;
    const scheduler = new Scheduler(jobs, new TriggerEngine(), async () => {
        sends += 1; return { status: "succeeded" };
    }, { canRetryJob: canRetryAutomationJob });
    cleanup.push(async () => { release.resolve(); await scheduler.stop(); });
    const running = scheduler.tick();
    await entered.promise;
    const cancelling = scheduler.cancel(job.id);
    release.resolve();
    assert.equal(await cancelling, true);
    await running;
    assert.equal(sends, 0);
    assert.equal((await jobs.get(job.id))?.status, "cancelled");
    assert.equal((await jobs.get(job.id))?.attempts, 0);
});
