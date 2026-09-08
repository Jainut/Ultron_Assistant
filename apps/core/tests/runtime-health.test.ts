import assert from "node:assert/strict";
import test from "node:test";
import { checkLocalOllamaHealth, publicServiceHealth, runtimeHealthSummary, waitForServiceReady } from "../src/system/runtime-health.ts";
import { ServiceSupervisor, type ServiceSnapshot } from "../src/system/service-supervisor.ts";

const snapshot = (name: string, state: ServiceSnapshot["state"]): ServiceSnapshot => ({
    name, state, attempts: 1, restarts: 0, updatedAt: Date.now(),
    lastFailure: { phase: "process", error: "fake-private-error", code: "EPIPE" },
});

test("saúde pública só expõe estado e contagens dos serviços conhecidos", () => {
    const projected = publicServiceHealth([snapshot("stt", "ready"), snapshot("private-name", "failed")]);
    assert.deepEqual(projected, [{ name: "stt", state: "ready", attempts: 1, restarts: 0 }]);
    assert.equal(JSON.stringify(projected).includes("private"), false);
    assert.equal(runtimeHealthSummary([snapshot("stt", "starting"), snapshot("tts", "ready")]).phase, "starting");
    assert.equal(runtimeHealthSummary([snapshot("stt", "ready"), snapshot("tts", "ready")]).phase, "ready");
    assert.match(runtimeHealthSummary([snapshot("stt", "failed"), snapshot("tts", "ready")]).detail, /terminal/);
    assert.equal(runtimeHealthSummary([snapshot("stt", "ready"), snapshot("tts", "ready"), snapshot("ollama", "failed")]).phase, "degraded");
    const warming = runtimeHealthSummary([snapshot("stt", "ready"), snapshot("tts", "ready"), snapshot("automation", "starting")]);
    assert.equal(warming.phase, "starting");
    assert.match(warming.detail, /inicializando: automation/);
    assert.doesNotMatch(warming.detail, /tools prontas/);
});

test("espera de voz usa eventos, cancela sem iniciar um serviço e retoma após ready", async () => {
    const supervisor = new ServiceSupervisor();
    let starts = 0;
    supervisor.register({ name: "stt", start: async () => { starts += 1; }, stop: () => undefined });
    try {
        const controller = new AbortController();
        const interrupted = waitForServiceReady(supervisor, "stt", controller.signal);
        const rejected = assert.rejects(interrupted, { name: "AbortError" });
        controller.abort();
        await rejected;
        assert.equal(starts, 0);
        let ready = false;
        const waiting = waitForServiceReady(supervisor, "stt", new AbortController().signal).then(() => { ready = true; });
        assert.equal(ready, false);
        await supervisor.start("stt");
        await waiting;
        assert.equal(ready, true);
        assert.equal(starts, 1);
    } finally { await supervisor.stopAll(); }
});

test("Ollama health somente consulta catálogo e verifica modelo, sem inferência", async () => {
    const requests: string[] = [];
    const transport = (async (input: RequestInfo | URL, options?: RequestInit) => {
        requests.push(String(input));
        assert.equal(options?.body, undefined);
        return new Response(JSON.stringify({ models: [{ name: "fake-model:latest" }] }));
    }) as typeof fetch;
    assert.equal(await checkLocalOllamaHealth("fake-model", undefined, transport), true);
    assert.equal(await checkLocalOllamaHealth("missing", undefined, transport), false);
    assert.deepEqual(requests, Array(2).fill("http://127.0.0.1:11434/api/tags"));
});

test("Ollama health cancelado propaga AbortSignal sem tocar rede real", async () => {
    const controller = new AbortController();
    const result = checkLocalOllamaHealth("fake", controller.signal, async (_input, options) => {
        return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
    });
    const rejected = assert.rejects(result, { name: "AbortError" });
    controller.abort();
    await rejected;
});
