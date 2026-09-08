import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createCoreSupervision, startCoreServices } from "../src/system/core-supervision.ts";
import { ServiceSupervisor } from "../src/system/service-supervisor.ts";
import { waitForServiceReady } from "../src/system/runtime-health.ts";
import { TerminalInput } from "../src/system/terminal-input.ts";
import { RemoteCommandInbox } from "../src/system/remote-command-inbox.ts";

function fakeServices(events: string[]) {
    const voice = (name: string) => ({
        start: async () => { events.push(`${name}:start`); },
        stop: () => { events.push(`${name}:stop`); },
        healthCheck: async () => true,
        onFailure: () => () => undefined,
    });
    const worker = (name: string) => ({ ...voice(name), waitUntilReady: async () => { events.push(`${name}:start`); } });
    return {
        stt: voice("stt"), tts: voice("tts"), tuya: worker("tuya"), tuyaHome: worker("tuya-home"),
        automation: {
            start: async () => { events.push("automation:start"); },
            stop: async () => { events.push("automation:stop"); }, isRunning: () => true,
        },
        ollamaHealth: async () => { events.push("ollama:health"); return true; },
    };
}

test("registro do core não faz I/O e respeita modos legados e integrações opcionais", async t => {
    const events: string[] = [];
    const { supervisor, backgroundServices } = createCoreSupervision({
        ...fakeServices(events), legacyLightProcess: true, discoveryDisabled: true,
    });
    t.after(() => supervisor.stopAll());
    assert.deepEqual(events, []);
    assert.deepEqual(supervisor.snapshots().map(item => item.name), ["stt", "tts", "automation", "ollama"]);
    assert.deepEqual(backgroundServices, ["automation", "ollama"]);
});

test("core inicia voz em paralelo, depois índices e serviços de fundo", async t => {
    const events: string[] = [];
    const controller = new AbortController();
    const options = fakeServices(events);
    let release: (() => void) | undefined;
    options.tts.start = async () => {
        events.push("tts:start");
        await new Promise<void>(resolve => { release = resolve; });
    };
    const core = createCoreSupervision(options);
    t.after(async () => { controller.abort(); await core.supervisor.stopAll(); });
    const startup = startCoreServices({
        ...core, signal: controller.signal, onBackgroundStart: () => { events.push("indexes:start"); },
    });
    await nextTurn();
    assert.deepEqual(events, ["stt:start", "tts:start"]);
    release?.();
    assert.equal((await startup.voice).every(item => item.status === "fulfilled"), true);
    await startup.background;
    assert.ok(events.indexOf("indexes:start") > events.indexOf("tts:start"));
    assert.ok(events.indexOf("tuya:start") > events.indexOf("indexes:start"));
    assert.ok(events.indexOf("automation:start") > events.indexOf("indexes:start"));
    assert.equal(core.supervisor.snapshots().every(item => item.state === "ready"), true);
});

test("voz travada não bloqueia terminal nem automações após a tolerância de startup", async t => {
    const supervisor = new ServiceSupervisor();
    const controller = new AbortController();
    const inbox = new RemoteCommandInbox();
    const terminal = new TerminalInput();
    const input = new PassThrough();
    let backgroundStarts = 0;
    let voiceReady = false;
    for (const name of ["stt", "tts"]) {
        supervisor.register({ name, start: () => new Promise<void>(() => undefined), stop: () => undefined });
    }
    supervisor.register({ name: "automation", start: async () => { ++backgroundStarts; }, stop: () => undefined });
    t.after(async () => {
        controller.abort(); terminal.stop(); input.destroy(); inbox.stop(); await supervisor.stopAll();
    });
    const startup = startCoreServices({
        supervisor, backgroundServices: ["automation"], signal: controller.signal,
        backgroundGraceMs: 10, onBackgroundStart: () => undefined,
    });
    const waiting = waitForServiceReady(supervisor, "stt", controller.signal).then(() => { voiceReady = true; });
    const stoppedWaiting = assert.rejects(waiting, { name: "AbortError" });
    terminal.start({
        input, accept: text => inbox.stage({ requestId: "typed-during-startup", text }).commit(),
        onError: message => assert.fail(message), onInterrupt: () => undefined,
    });
    const command = inbox.next();
    input.write("que horas são?\n");
    assert.equal((await command).text, "que horas são?");
    assert.equal(voiceReady, false);
    await startup.background;
    assert.equal(backgroundStarts, 1);
    assert.equal(supervisor.snapshot("stt").state, "starting");
    controller.abort();
    await stoppedWaiting;
    assert.equal((await startup.voice).every(item => item.status === "rejected"), true);
});

test("encerrar durante startup cancela a espera e não inicia índices ou serviços tardios", async t => {
    const supervisor = new ServiceSupervisor();
    const controller = new AbortController();
    let backgroundStarts = 0;
    for (const name of ["stt", "tts"]) {
        supervisor.register({ name, start: () => new Promise<void>(() => undefined), stop: () => undefined });
    }
    supervisor.register({ name: "automation", start: async () => { ++backgroundStarts; }, stop: () => undefined });
    t.after(() => supervisor.stopAll());
    const startup = startCoreServices({
        supervisor, backgroundServices: ["automation"], signal: controller.signal,
        onBackgroundStart: () => { ++backgroundStarts; },
    });
    const aborted = assert.rejects(startup.background, { name: "AbortError" });
    controller.abort();
    await aborted;
    await startup.voice;
    assert.equal(backgroundStarts, 0);
    assert.equal(supervisor.snapshot("automation").state, "stopped");
});

test("Ollama e providers indisponíveis recuperam somente por health, sem reiniciar ações", async t => {
    const events: string[] = [];
    let online = false;
    let probes = 0;
    const { supervisor } = createCoreSupervision({
        ...fakeServices(events),
        ollamaHealth: async () => online,
        providers: {
            gmail: {
                id: "google-mail", kind: "mail", displayName: "Google Mail",
                healthCheck: async () => {
                    ++probes;
                    return { providerId: "google-mail", status: online ? "ready" : "unavailable", checkedAt: new Date() };
                },
            },
        },
    });
    t.after(() => supervisor.stopAll());
    await assert.rejects(supervisor.start("ollama"));
    await assert.rejects(supervisor.start("gmail"));
    assert.equal(supervisor.snapshot("ollama").state, "failed");
    assert.equal(supervisor.snapshot("gmail").restarts, 0);
    online = true;
    assert.equal((await supervisor.checkNow("gmail")).state, "ready");
    assert.equal((await supervisor.checkNow("ollama")).state, "ready");
    assert.equal(supervisor.snapshot("gmail").attempts, 1);
    assert.equal(probes, 2);
    assert.deepEqual(events, []);
});
