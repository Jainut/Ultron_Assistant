import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

import { SpeechToTextService, type SpeechToTextServiceOptions } from "../src/speech/speech-to-text.ts";
import { VoiceServiceChild } from "./support/voice-service-child.ts";

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) assert.fail("Condição do processo falso não ocorreu.");
        await nextTurn();
    }
}

function mockedService(t: TestContext, options: SpeechToTextServiceOptions = {}, autoReady = true) {
    const children: VoiceServiceChild[] = [];
    const service = new SpeechToTextService({
        fetch: (async () => new Response("OK")) as typeof fetch,
        healthTimeoutMs: 100,
        pollIntervalMs: 1,
        spawnService: ((command: string) => {
            const child = new VoiceServiceChild();
            children.push(child);
            if (!command.endsWith("whisper-server.exe") && autoReady) {
                queueMicrotask(() => child.send({ type: "ready", detector: "rms" }));
            }
            return child.asProcess();
        }) as unknown as typeof spawn,
        ...options,
    });
    t.after(() => service.stop());
    return { service, children };
}

async function audioFixture(t: TestContext, name = "utterance.wav"): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-stt-lifecycle-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const audioPath = path.join(directory, name);
    await writeFile(audioPath, Buffer.from("RIFF-fake-audio-never-played"));
    return audioPath;
}

test("STT start é single-flight e exige ready da captura, não apenas HTTP do Whisper", async t => {
    const { service, children } = mockedService(t, {}, false);
    const first = service.start();
    assert.equal(service.start(), first);
    assert.equal(children.length, 1);
    let resolved = false;
    void first.then(() => { resolved = true; });
    await until(() => children.length === 2);
    assert.equal(service.isReady(), false);
    assert.equal(resolved, false);
    children[1].send({ type: "ready" });
    await first;
    assert.equal(service.isReady(), true);
    assert.equal(await service.healthCheck(), true);
    await service.start();
    assert.equal(children.length, 2);
});

test("erro de spawn Whisper rejeita startup imediatamente e permite nova geração", async t => {
    const { service, children } = mockedService(t);
    const failures: Error[] = [];
    service.onFailure(error => failures.push(error));
    const first = service.start();
    const rejected = assert.rejects(first, /ENOENT whisper/);
    children[0].emit("error", new Error("ENOENT whisper"));
    await rejected;
    assert.equal(service.isReady(), false);
    assert.equal(children[0].killed, true);
    await service.start();
    children[0].close(1);
    assert.equal(service.isReady(), true);
    assert.equal(children.length, 3);
    assert.equal(failures.length, 1);
});

test("erro, close e protocolo fatal antes de ready da captura rejeitam startup", async t => {
    for (const event of ["error", "close", "protocol"] as const) {
        const { service, children } = mockedService(t, {}, false);
        const startup = service.start();
        await until(() => children.length === 2);
        const rejected = assert.rejects(startup, /captura failed|encerrou/);
        if (event === "error") children[1].emit("error", new Error("captura failed"));
        else if (event === "close") children[1].close(0);
        else children[1].send({ type: "error", error: "captura failed" });
        await rejected;
        assert.equal(children.every(child => child.killed), true);
        assert.equal(service.isReady(), false);
    }
});

test("timeouts Whisper/captura encerram filhos e não confirmam prontidão", async t => {
    const stalled = mockedService(t, {
        fetch: (() => new Promise<Response>(() => undefined)) as typeof fetch,
        whisperStartupTimeoutMs: 15,
    });
    await assert.rejects(stalled.service.start(), /Whisper startup.*tempo limite/);
    assert.equal(stalled.children.length, 1);
    assert.equal(stalled.children[0].killed, true);

    const capture = mockedService(t, { captureStartupTimeoutMs: 15 }, false);
    await assert.rejects(capture.service.start(), /Captura startup.*tempo limite/);
    assert.equal(capture.children.every(child => child.killed), true);
});

test("stop durante startup cancela até fetch que ignora signal; callbacks antigos não afetam restart", async t => {
    let releaseFirst: ((response: Response) => void) | undefined;
    let firstProbe = true;
    const { service, children } = mockedService(t, {
        fetch: (async () => {
            if (firstProbe) {
                firstProbe = false;
                return new Promise<Response>(resolve => { releaseFirst = resolve; });
            }
            return new Response("OK");
        }) as typeof fetch,
    });
    const startup = service.start();
    const rejected = assert.rejects(startup, { name: "AbortError" });
    service.stop();
    await rejected;
    await service.start();
    releaseFirst?.(new Response("old startup"));
    children[0].close(1);
    await nextTurn();
    assert.equal(service.isReady(), true);
    assert.equal(children.length, 3);
});

test("AbortSignal do dono cancela startup sem emitir failure; cancelamento de outro waiter é isolado", async t => {
    const { service, children } = mockedService(t, {}, false);
    const failures: Error[] = [];
    service.onFailure(error => failures.push(error));
    const owner = new AbortController();
    const waiter = new AbortController();
    const startup = service.start(owner.signal);
    const second = service.start(waiter.signal);
    const secondRejected = assert.rejects(second, { name: "AbortError" });
    waiter.abort();
    await secondRejected;
    assert.equal(children[0].killed, false);
    const rejected = assert.rejects(startup, { name: "AbortError" });
    owner.abort();
    await rejected;
    assert.equal(children.every(child => child.killed), true);
    assert.equal(failures.length, 0);
});

test("queda pós-ready de qualquer filho rejeita listen e encerra a sessão uma única vez", async t => {
    for (const event of ["whisper-exit", "capture-error", "stdin-error", "protocol"] as const) {
        const { service, children } = mockedService(t);
        const failures: Error[] = [];
        const unsubscribe = service.onFailure(error => failures.push(error));
        service.onFailure(() => { throw new Error("bad observer"); });
        await service.start();
        const pending = service.listen();
        const rejected = assert.rejects(pending, /encerrou|capture failure|EPIPE|capture fatal/);
        if (event === "whisper-exit") children[0].emit("exit", 0);
        else if (event === "capture-error") children[1].emit("error", new Error("capture failure"));
        else if (event === "stdin-error") children[1].stdin.emit("error", new Error("EPIPE"));
        else children[1].send({ type: "error", error: "capture fatal" });
        await rejected;
        children[0].close(1);
        children[1].close(1);
        assert.equal(failures.length, 1);
        assert.equal(service.isReady(), false);
        assert.equal(await service.healthCheck(), false);
        assert.equal(children.every(child => child.killed), true);
        unsubscribe();
        service.stop();
        assert.equal(failures.length, 1);
    }
});

test("stop rejeita escuta pendente mesmo sem close; ready antigo é ignorado", async t => {
    const { service, children } = mockedService(t);
    await service.start();
    const rejected = assert.rejects(service.listen(), { name: "AbortError" });
    service.stop();
    await rejected;
    await service.start();
    children[1].send({ type: "ready" });
    children[1].close(1);
    assert.equal(service.isReady(), true);
    const controller = new AbortController();
    const listen = service.listen(controller.signal);
    const aborted = assert.rejects(listen, { name: "AbortError" });
    controller.abort();
    await aborted;
    assert.equal(children[3].messages.at(-1)?.type, "pause");
    assert.equal(service.isReady(), true);
});

test("STT mantém idioma/prompt, retorna texto e remove WAV temporário", async t => {
    const audioPath = await audioFixture(t);
    let submitted: FormData | undefined;
    const { service, children } = mockedService(t, {
        fetch: (async (_input, init) => {
            if (init?.method === "POST") {
                submitted = init.body as FormData;
                return new Response("  abre o spotify  ");
            }
            return new Response("OK");
        }) as typeof fetch,
    });
    await service.start();
    const pending = service.listen();
    children[1].send({ type: "audio", path: audioPath });
    assert.equal(await pending, "abre o spotify");
    assert.equal(submitted?.get("language"), "pt");
    assert.equal(submitted?.get("response_format"), "text");
    assert.equal(submitted?.get("carry_initial_prompt"), "true");
    assert.ok(String(submitted?.get("prompt")).length > 0);
    await assert.rejects(readFile(audioPath), { code: "ENOENT" });
});

test("transcrição cancelada/tardia não satisfaz escuta nova nem altera contexto", async t => {
    const firstAudio = await audioFixture(t, "old.wav");
    const secondAudio = await audioFixture(t, "new.wav");
    let postCount = 0;
    let releaseOld: ((response: Response) => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    const { service, children } = mockedService(t, {
        fetch: (async (_input, init) => {
            if (init?.method !== "POST") return new Response("OK");
            if (++postCount === 1) {
                oldSignal = init.signal as AbortSignal;
                return new Promise<Response>(resolve => { releaseOld = resolve; });
            }
            assert.equal(String((init.body as FormData).get("prompt")).includes("frase antiga"), false);
            return new Response("nova frase");
        }) as typeof fetch,
    });
    await service.start();
    const controller = new AbortController();
    const old = service.listen(controller.signal);
    const rejected = assert.rejects(old, { name: "AbortError" });
    children[1].send({ type: "audio", path: firstAudio });
    await until(() => postCount === 1);
    controller.abort();
    await rejected;
    assert.equal(oldSignal?.aborted, true);
    const current = service.listen();
    children[1].send({ type: "audio", path: secondAudio });
    releaseOld?.(new Response("frase antiga"));
    assert.equal(await current, "nova frase");
    assert.equal(service.isReady(), true);
});

test("inference com timeout cancela HTTP e encerra sessão travada antes de novo startup", async t => {
    const audioPath = await audioFixture(t);
    let requestSignal: AbortSignal | undefined;
    const { service, children } = mockedService(t, {
        transcriptionTimeoutMs: 15,
        fetch: (async (_input, init) => {
            if (init?.method === "POST") {
                requestSignal = init.signal as AbortSignal;
                return new Promise<Response>(() => undefined);
            }
            return new Response("OK");
        }) as typeof fetch,
    });
    await service.start();
    const rejected = assert.rejects(service.listen(), /STT transcription.*tempo limite/);
    children[1].send({ type: "audio", path: audioPath });
    await rejected;
    assert.equal(requestSignal?.aborted, true);
    assert.equal(service.isReady(), false);
    assert.equal(children.every(child => child.killed), true);
    await service.start();
    assert.equal(service.isReady(), true);
    const next = assert.rejects(service.listen(), { name: "AbortError" });
    service.stop();
    await next;
});

test("health não compete com inferência em andamento e cancelamento do probe é respeitado", async t => {
    const audioPath = await audioFixture(t);
    let probes = 0;
    let inferenceStarted = false;
    const { service, children } = mockedService(t, {
        fetch: (async (_input, init) => {
            if (init?.method === "POST") {
                inferenceStarted = true;
                return new Promise<Response>(() => undefined);
            }
            ++probes;
            return new Response("OK");
        }) as typeof fetch,
    });
    await service.start();
    const pending = service.listen();
    const rejected = assert.rejects(pending, { name: "AbortError" });
    children[1].send({ type: "audio", path: audioPath });
    await until(() => inferenceStarted);
    assert.equal(await service.healthCheck(), true);
    assert.equal(probes, 1);
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(service.healthCheck(canceled.signal), { name: "AbortError" });
    service.stop();
    await rejected;
});

test("startup tardio restaura playback e referência antes do primeiro resume", async t => {
    const { service, children } = mockedService(t, {}, false);
    const reference = { path: "C:/fake/current.wav", generation: 4, startedAtUnixMs: 1_000 };
    // Same ordering as TTS starting while the Whisper/capture service is offline.
    service.setPlaybackActive(true);
    service.startPlaybackReference(reference);
    const startup = service.start();
    const controller = new AbortController();
    const listening = startup.then(() => service.listen(controller.signal));
    const cancelled = assert.rejects(listening, { name: "AbortError" });
    await until(() => children.length === 2);
    children[1].send({ type: "ready" });
    await startup;
    await nextTurn();
    assert.deepEqual(children[1].messages, [
        { type: "playback", active: true },
        { type: "playback_reference_start", ...reference },
        { type: "resume" },
    ]);
    controller.abort();
    await cancelled;
});

test("capture reiniciada durante playback restaura a referência ativa da conversa", async t => {
    const { service, children } = mockedService(t);
    const reference = { path: "C:/fake/current.wav", generation: 7, startedAtUnixMs: 2_000 };
    await service.start();
    service.setPlaybackActive(true);
    service.startPlaybackReference(reference);
    children[1].emit("error", new Error("fake microphone failure"));
    await service.start();
    assert.deepEqual(children[3].messages, [
        { type: "playback", active: true },
        { type: "playback_reference_start", ...reference },
    ]);
    const controller = new AbortController();
    const cancelled = assert.rejects(service.listen(controller.signal), { name: "AbortError" });
    assert.equal(children[3].messages.at(-1)?.type, "resume");
    controller.abort();
    await cancelled;
});

test("referência terminada enquanto captura está offline não reaparece após restart", async t => {
    const { service, children } = mockedService(t);
    const reference = { path: "C:/fake/finished.wav", generation: 9, startedAtUnixMs: 3_000 };
    await service.start();
    service.setPlaybackActive(true);
    service.startPlaybackReference(reference);
    service.stop();
    service.endPlaybackReference(reference);
    await service.start();
    assert.deepEqual(children[3].messages, [{ type: "playback", active: true }]);
    service.stop();
    service.setPlaybackActive(false);
    await service.start();
    assert.deepEqual(children[5].messages, [{ type: "playback", active: false }]);
});

test("fim atrasado de referência antiga não apaga a referência mais recente", async t => {
    const { service, children } = mockedService(t);
    const previous = { path: "C:/fake/old.wav", generation: 1, startedAtUnixMs: 4_000 };
    const current = { path: "C:/fake/new.wav", generation: 2, startedAtUnixMs: 5_000 };
    service.setPlaybackActive(true);
    service.startPlaybackReference(previous);
    service.startPlaybackReference(current);
    service.endPlaybackReference(previous);
    await service.start();
    assert.deepEqual(children[1].messages, [
        { type: "playback", active: true },
        { type: "playback_reference_start", ...current },
    ]);
});

test("playback desativado offline invalida referência e snapshot não depende do objeto externo", async t => {
    const { service, children } = mockedService(t);
    const reference = { path: "C:/fake/original.wav", generation: 1, startedAtUnixMs: 6_000 };
    service.setPlaybackActive(true);
    service.startPlaybackReference(reference);
    reference.path = "C:/fake/modified-by-caller.wav";
    await service.start();
    assert.equal(children[1].messages[1].path, "C:/fake/original.wav");
    service.stop();
    service.setPlaybackActive(false);
    await service.start();
    assert.deepEqual(children[3].messages, [{ type: "playback", active: false }]);
});
