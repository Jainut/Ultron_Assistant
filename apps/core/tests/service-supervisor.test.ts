import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

import { ServiceSupervisor, type ServicePolicy, type ServiceState } from "../src/system/service-supervisor.ts";
import { timedServiceOperation } from "../src/system/service-lifecycle.ts";

const policy: ServicePolicy = {
    maxRestarts: 2, startupTimeoutMs: 200, healthTimeoutMs: 200,
    stopTimeoutMs: 100, healthIntervalMs: 0, backoffMs: 0,
};

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) assert.fail("Estado esperado não foi observado.");
        await nextTurn();
    }
}

test("supervisor start single-flight, snapshots isolados e unsubscribe do observador", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let release: (() => void) | undefined;
    const states: ServiceState[] = [];
    supervisor.register({ name: "stt", policy,
        start: async () => { ++starts; await new Promise<void>(resolve => { release = resolve; }); },
        stop: () => undefined, health: () => true });
    supervisor.onStateChange(() => { throw new Error("observer failure"); });
    const unsubscribe = supervisor.onStateChange(snapshot => states.push(snapshot.state));
    const first = supervisor.start("stt");
    assert.equal(supervisor.start("stt"), first);
    await until(() => starts === 1);
    release?.();
    await first;
    assert.deepEqual(states, ["starting", "ready"]);
    assert.equal(supervisor.snapshot("stt").attempts, 1);
    const snapshot = supervisor.snapshots()[0];
    snapshot.state = "failed";
    assert.equal(supervisor.snapshot("stt").state, "ready");
    unsubscribe();
    await supervisor.stop("stt");
    assert.deepEqual(states, ["starting", "ready"]);
});

test("startup recupera com backoff limitado e nunca precisa de replay de tools", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let stops = 0;
    let writes = 0;
    const mutateTool = (): void => { ++writes; };
    supervisor.register({ name: "tts", policy,
        start: async () => { if (++starts < 3) throw new Error("temporary startup failure"); },
        stop: () => { ++stops; }, health: () => true });
    await supervisor.start("tts");
    assert.equal(starts, 3);
    assert.equal(stops, 2);
    assert.equal(supervisor.snapshot("tts").restarts, 2);
    assert.equal(supervisor.snapshot("tts").state, "ready");
    assert.equal(writes, 0);
    mutateTool();
    assert.equal(writes, 1);
});

test("orçamento de reinícios acaba mesmo quando o serviço fica pronto entre quedas", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let report: ((error: Error) => void) | undefined;
    supervisor.register({ name: "capture", policy,
        start: async () => { ++starts; }, stop: () => undefined,
        onFailure: listener => { report = listener; return () => { report = undefined; }; } });
    await supervisor.start("capture");
    for (let failure = 0; failure < 3; failure++) {
        report?.(new Error("process died"));
        await supervisor.checkNow("capture");
    }
    assert.equal(supervisor.snapshot("capture").state, "failed");
    assert.equal(supervisor.snapshot("capture").restarts, 2);
    assert.equal(starts, 3);
    report?.(new Error("another close"));
    await nextTurn();
    assert.equal(starts, 3);
    await supervisor.start("capture");
    assert.equal(starts, 4);
    assert.equal(supervisor.snapshot("capture").restarts, 0);
});

test("startup que ignora AbortSignal tem timeout bounded e estado failed", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    const signals: AbortSignal[] = [];
    let stops = 0;
    supervisor.register({ name: "hung", policy: { ...policy, startupTimeoutMs: 10, maxRestarts: 1 },
        start: signal => { signals.push(signal); return new Promise<void>(() => undefined); },
        stop: () => { ++stops; } });
    await assert.rejects(supervisor.start("hung"), /Limite de reinicializações/);
    assert.equal(signals.length, 2);
    assert.equal(signals.every(signal => signal.aborted), true);
    assert.equal(stops, 2);
    assert.equal(supervisor.snapshot("hung").state, "failed");
});

test("health falsa ou bloqueada recupera de forma limitada sem ficar ready por engano", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let checks = 0;
    supervisor.register({ name: "whisper", policy: { ...policy, healthTimeoutMs: 10, maxRestarts: 1 },
        start: async () => { ++starts; }, stop: () => undefined,
        health: () => ++checks === 1 ? true : new Promise<boolean>(() => undefined) });
    await supervisor.start("whisper");
    const result = await supervisor.checkNow("whisper");
    assert.equal(result.state, "failed");
    assert.equal(starts, 2);
    assert.equal(checks, 3);
});

test("failure durante health cancela o check e não perde recuperação", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let checks = 0;
    let healthSignal: AbortSignal | undefined;
    let releaseHealth: ((healthy: boolean) => void) | undefined;
    let report: ((error: Error) => void) | undefined;
    supervisor.register({ name: "model", policy,
        start: async () => { ++starts; }, stop: () => undefined,
        health: signal => {
            if (++checks !== 2) return true;
            healthSignal = signal;
            return new Promise<boolean>(resolve => { releaseHealth = resolve; });
        },
        onFailure: listener => { report = listener; return () => undefined; } });
    await supervisor.start("model");
    const checking = supervisor.checkNow("model");
    await until(() => checks === 2);
    report?.(new Error("process failure during GET"));
    releaseHealth?.(true);
    await checking;
    assert.equal(healthSignal?.aborted, true);
    assert.equal(starts, 2);
    assert.equal(supervisor.snapshot("model").state, "ready");
    assert.equal(supervisor.snapshot("model").restarts, 1);
});

test("failure na transição ready não some na janela antes de resolver startup", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let report: ((error: Error) => void) | undefined;
    supervisor.register({ name: "race", policy,
        start: async () => { ++starts; }, stop: () => undefined,
        onFailure: listener => { report = listener; return () => undefined; } });
    supervisor.onStateChange(snapshot => {
        if (snapshot.state === "ready" && starts === 1) report?.(new Error("just died"));
    });
    await supervisor.start("race");
    await supervisor.checkNow("race");
    assert.equal(starts, 2);
    assert.equal(supervisor.snapshot("race").state, "ready");
});

test("stop em startup aborta provider, resolve shutdown e permite start explícito novo", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let firstSignal: AbortSignal | undefined;
    let lateReady: (() => void) | undefined;
    supervisor.register({ name: "slow", policy,
        start: async signal => {
            if (++starts > 1) return;
            firstSignal = signal;
            await new Promise<void>(resolve => { lateReady = resolve; });
        }, stop: () => undefined });
    const starting = supervisor.start("slow");
    const rejected = assert.rejects(starting, { name: "AbortError" });
    await until(() => starts === 1);
    await supervisor.stop("slow");
    await rejected;
    assert.equal(firstSignal?.aborted, true);
    assert.equal(supervisor.snapshot("slow").state, "stopped");
    await supervisor.start("slow");
    lateReady?.();
    await nextTurn();
    assert.equal(supervisor.snapshot("slow").state, "ready");
    assert.equal(starts, 2);
});

test("shutdown durante backoff cancela retries, remove listeners e recusa nova inicialização", async () => {
    const supervisor = new ServiceSupervisor();
    let starts = 0;
    let unsubscribed = false;
    supervisor.register({ name: "failed", policy: { ...policy, backoffMs: 10_000 },
        start: async () => { ++starts; throw new Error("unavailable"); }, stop: () => undefined,
        onFailure: () => () => { unsubscribed = true; } });
    const starting = supervisor.start("failed");
    const rejected = assert.rejects(starting, { name: "AbortError" });
    await until(() => supervisor.snapshot("failed").state === "restarting");
    await supervisor.stopAll();
    await rejected;
    assert.equal(supervisor.snapshot("failed").state, "stopped");
    assert.equal(unsubscribed, true);
    assert.equal(starts, 1);
    await assert.rejects(supervisor.start("failed"), { name: "AbortError" });
});

test("falha/timeout ao parar não inicia uma segunda cópia sobre serviço antigo", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    supervisor.register({ name: "uncooperative", policy: { ...policy, stopTimeoutMs: 10 },
        start: async () => { ++starts; throw new Error("startup failure"); },
        stop: () => new Promise<void>(() => undefined) });
    await assert.rejects(supervisor.start("uncooperative"), /stop.*tempo limite/);
    assert.equal(supervisor.snapshot("uncooperative").state, "failed");
    assert.equal(supervisor.snapshot("uncooperative").lastFailure?.phase, "shutdown");
    assert.equal(starts, 1);
});

test("startAll preserva serviços saudáveis e snapshots não incluem mensagens/payloads sensíveis", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    supervisor.register({ name: "ok", policy, start: async () => undefined, stop: () => undefined });
    const failure = Object.assign(new Error("private transcript and token=secret"), { code: "ECONNREFUSED" });
    supervisor.register({ name: "optional", policy: { ...policy, maxRestarts: 0 },
        start: async () => { throw failure; }, stop: () => undefined });
    const snapshots = await supervisor.startAll();
    assert.deepEqual(snapshots.map(snapshot => [snapshot.name, snapshot.state]), [["ok", "ready"], ["optional", "failed"]]);
    assert.equal(JSON.stringify(snapshots).includes("secret"), false);
    assert.deepEqual(supervisor.snapshot("optional").lastFailure,
        { phase: "startup", error: "Error", code: "ECONNREFUSED" });
});

test("cancelar outro waiter não cancela inicialização compartilhada", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let release: (() => void) | undefined;
    supervisor.register({ name: "shared", policy,
        start: () => new Promise<void>(resolve => { release = resolve; }), stop: () => undefined });
    const first = supervisor.start("shared");
    const controller = new AbortController();
    const waiter = supervisor.start("shared", controller.signal);
    const rejected = assert.rejects(waiter, { name: "AbortError" });
    await until(() => release !== undefined);
    controller.abort();
    await rejected;
    release?.();
    await first;
    assert.equal(supervisor.snapshot("shared").state, "ready");
});

test("health periódico é limitado e para depois de stop", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let checks = 0;
    supervisor.register({ name: "periodic", policy: { ...policy, healthIntervalMs: 5 },
        start: async () => undefined, stop: () => undefined, health: () => { ++checks; return true; } });
    await supervisor.start("periodic");
    await until(() => checks >= 2);
    await supervisor.stop("periodic");
    const atStop = checks;
    await delay(20);
    assert.equal(checks, atStop);
});

test("operação com timeout sinaliza o provider e ignora conclusão tardia", async () => {
    let signal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const task = timedServiceOperation(innerSignal => {
        signal = innerSignal;
        return new Promise<void>(resolve => { release = resolve; });
    }, { timeoutMs: 10, label: "test provider" });
    await assert.rejects(task, /tempo limite/);
    assert.equal(signal?.aborted, true);
    release?.();
    await nextTurn();
});

test("probeWhenFailed recupera serviço externo com health read-only sem repetir start/stop", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let stops = 0;
    let checks = 0;
    let online = false;
    supervisor.register({ name: "external", policy: { ...policy, maxRestarts: 0, probeWhenFailed: true },
        start: async () => { ++starts; throw new Error("offline"); },
        stop: () => { ++stops; }, health: () => { ++checks; return online; } });
    await assert.rejects(supervisor.start("external"));
    assert.equal((await supervisor.checkNow("external")).state, "failed");
    online = true;
    assert.equal((await supervisor.checkNow("external")).state, "ready");
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    assert.equal(checks, 2);
});

test("probeWhenFailed default false e shutdown impedem health depois de encerrar", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let probes = 0;
    supervisor.register({ name: "voice", policy: { ...policy, maxRestarts: 0 },
        start: async () => { throw new Error("offline"); }, stop: () => undefined,
        health: () => { ++probes; return true; } });
    await assert.rejects(supervisor.start("voice"));
    await supervisor.checkNow("voice");
    assert.equal(probes, 0);
    await supervisor.stopAll();
    await supervisor.checkNow("voice");
    assert.equal(probes, 0);
});

test("probeWhenFailed automático mantém intervalo e nunca reinicia provider externo", async t => {
    const supervisor = new ServiceSupervisor();
    t.after(() => supervisor.stopAll());
    let starts = 0;
    let probes = 0;
    supervisor.register({ name: "network", policy: { ...policy, maxRestarts: 0,
        probeWhenFailed: true, healthIntervalMs: 5 },
        start: async () => { ++starts; throw new Error("offline"); }, stop: () => undefined,
        health: () => ++probes >= 2 });
    await assert.rejects(supervisor.start("network"));
    await until(() => supervisor.snapshot("network").state === "ready");
    assert.equal(starts, 1);
    assert.equal(probes, 2);
    await supervisor.stop("network");
    await delay(20);
    assert.equal(probes, 2);
});

test("abort síncrono dentro do provider vence resultado já resolvido", async () => {
    const controller = new AbortController();
    await assert.rejects(timedServiceOperation(() => {
        controller.abort();
        return Promise.resolve("late ready");
    }, { signal: controller.signal, timeoutMs: 100, label: "synchronous abort" }), { name: "AbortError" });
});
