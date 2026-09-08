import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

import { TextToSpeechService, type TextToSpeechServiceOptions } from "../src/speech/text-to-speech.ts";
import { SpeechQueue } from "../src/speech/speech-queue.ts";
import { VoiceServiceChild } from "./support/voice-service-child.ts";

const ready = { type: "ready", capabilities: ["synthesis-v1", "playback-v1"] };

function mockedService(t: TestContext, options: TextToSpeechServiceOptions = {}) {
    const children: VoiceServiceChild[] = [];
    let fallbacks = 0;
    const service = new TextToSpeechService({
        playFallback: async () => { ++fallbacks; }, stopFallback: () => undefined,
        spawnService: (() => {
            const child = new VoiceServiceChild();
            children.push(child);
            return child.asProcess();
        }) as unknown as typeof spawn,
        ...options,
    });
    t.after(() => service.stop());
    const start = async (): Promise<VoiceServiceChild> => {
        const starting = service.start();
        const child = children.at(-1)!;
        child.send(ready);
        await starting;
        return child;
    };
    return { service, children, start, fallbacks: () => fallbacks };
}

async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) assert.fail("Condição fake não ocorreu.");
        await nextTurn();
    }
}

test("timeout de síntese mata worker, rejeita todas as pendências e emite failure uma vez", async t => {
    const { service, start, fallbacks } = mockedService(t, { synthesisTimeoutMs: 15 });
    const failures: Error[] = [];
    service.onFailure(error => failures.push(error));
    const child = await start();
    const synthesis = service.synthesize("Frase fixa.");
    const playback = service.play("C:/fake/current.wav");
    const rejected = Promise.all([
        assert.rejects(synthesis, /TTS synthesis.*tempo limite/),
        assert.rejects(playback, /TTS synthesis.*tempo limite/),
    ]);
    await rejected;
    child.close(1);
    assert.equal(child.killed, true);
    assert.equal(failures.length, 1);
    assert.equal(service.isReady(), false);
    assert.equal(fallbacks(), 0);
    const retry = await start();
    await delay(35);
    assert.equal(retry.killed, false);
    assert.equal(service.isReady(), true);
});

test("playback sem ACK ou terminal expira sem duplicar áudio no fallback", async t => {
    for (const startsAudio of [false, true]) {
        const { service, start, fallbacks } = mockedService(t, { playbackTimeoutMs: 15 });
        const child = await start();
        const pending = service.play("C:/fake/audio.wav");
        const play = child.messages.find(message => message.type === "play");
        if (startsAudio) child.send({ id: play?.id, type: "playback_started" });
        await assert.rejects(pending, /TTS playback.*tempo limite/);
        assert.equal(child.killed, true);
        assert.equal(fallbacks(), 0);
    }
});

test("cancel_playback sem ACK usa prazo curto e encerra worker mesmo antes de playback_started", async t => {
    const { service, start, fallbacks } = mockedService(t, { playbackCancelTimeoutMs: 15 });
    const child = await start();
    const controller = new AbortController();
    const pending = service.play("C:/fake/cancel.wav", { signal: controller.signal });
    const rejected = assert.rejects(pending, /TTS cancel ACK.*tempo limite/);
    controller.abort();
    await rejected;
    assert.equal(child.messages.at(-1)?.type, "cancel_playback");
    assert.equal(child.killed, true);
    assert.equal(fallbacks(), 0);
});

test("flush ACK não substitui confirmação terminal: SpeechQueue não fica pendurada", async t => {
    t.mock.method(console, "error", () => undefined);
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-tts-deadline-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const audioPath = path.join(directory, "never-played.wav");
    await writeFile(audioPath, Buffer.from("RIFF-fake-audio"));
    const { service, start, fallbacks } = mockedService(t, { playbackCancelTimeoutMs: 15 });
    const child = await start();
    const queue = new SpeechQueue(service);
    queue.enqueue("Frase fixa.");
    await until(() => child.messages.some(message => message.type === "speak"));
    const synthesis = child.messages.find(message => message.type === "speak");
    child.send({ id: synthesis?.id, type: "audio_ready", path: audioPath });
    await until(() => child.messages.some(message => message.type === "play"));
    const play = child.messages.find(message => message.type === "play");
    child.send({ id: play?.id, type: "playback_started" });
    await queue.interrupt();
    const flush = child.messages.find(message => message.type === "flush_playback");
    child.send({ id: flush?.id, type: "playback_flushed" });
    await queue.waitUntilIdle();
    assert.equal(queue.isSpeaking(), false);
    assert.equal(child.killed, true);
    assert.equal(fallbacks(), 0);
    await assert.rejects(readFile(audioPath), { code: "ENOENT" });
});

test("flush sem ACK expira mesmo sem um playback pendente", async t => {
    const { service, start } = mockedService(t, { playbackCancelTimeoutMs: 15 });
    const child = await start();
    service.stopPlayback();
    await until(() => child.killed);
    assert.equal(service.isReady(), false);
});

test("ACKs terminais removem deadlines e preservam player para próxima fala", async t => {
    const { service, start } = mockedService(t, {
        synthesisTimeoutMs: 20, playbackTimeoutMs: 20, playbackCancelTimeoutMs: 20,
    });
    const child = await start();
    const synthesis = service.synthesize("Frase fixa.");
    const speak = child.messages.find(message => message.type === "speak");
    child.send({ id: speak?.id, type: "audio_ready", path: "C:/fake/audio.wav" });
    assert.equal(await synthesis, "C:/fake/audio.wav");
    const controller = new AbortController();
    const playback = service.play("C:/fake/audio.wav", { signal: controller.signal });
    const play = child.messages.find(message => message.type === "play");
    const canceled = assert.rejects(playback, { name: "AbortError" });
    controller.abort();
    child.send({ id: play?.id, type: "playback_cancelled" });
    await canceled;
    service.stopPlayback();
    const flush = child.messages.find(message => message.type === "flush_playback");
    child.send({ id: flush?.id, type: "playback_flushed" });
    await delay(45);
    assert.equal(child.killed, false);
    assert.equal(service.isReady(), true);
});

test("cancelamento cooperativo de síntese mantém deadline até terminal Python sem travar caller", async t => {
    const { service, start } = mockedService(t, { synthesisTimeoutMs: 20 });
    const child = await start();
    const controller = new AbortController();
    const synthesis = service.synthesize("Frase fixa.", controller.signal);
    const speak = child.messages.find(message => message.type === "speak");
    const rejected = assert.rejects(synthesis, { name: "AbortError" });
    controller.abort();
    await rejected;
    child.send({ id: speak?.id, type: "error", error: "Síntese cancelada." });
    await delay(40);
    assert.equal(child.killed, false);
    const nextController = new AbortController();
    const next = assert.rejects(service.synthesize("Outra frase fixa.", nextController.signal), { name: "AbortError" });
    nextController.abort();
    await next;
    await until(() => child.killed);
    assert.equal(service.isReady(), false);
});

test("fallback legado continua só em ausência de capability ou recusa explícita antes de áudio", async t => {
    const legacy = mockedService(t);
    const starting = legacy.service.start();
    legacy.children[0].send({ type: "ready", capabilities: ["synthesis-v1"] });
    await starting;
    await legacy.service.play("C:/fake/legacy.wav");
    assert.equal(legacy.fallbacks(), 1);

    const modern = mockedService(t);
    const child = await modern.start();
    const refused = modern.service.play("C:/fake/refused.wav");
    const play = child.messages.find(message => message.type === "play");
    child.send({ id: play?.id, type: "error", error: "Playback persistente indisponível." });
    await refused;
    assert.equal(modern.fallbacks(), 1);
    const unknown = modern.service.play("C:/fake/unknown.wav");
    const rejected = assert.rejects(unknown, /EPIPE/);
    child.stdin.emit("error", new Error("EPIPE"));
    await rejected;
    assert.equal(modern.fallbacks(), 1);
});

test("fallback bloqueado também tem deadline e stop sem depender de close", async t => {
    let stops = 0;
    const { service, children } = mockedService(t, {
        playbackTimeoutMs: 15,
        playFallback: () => new Promise<void>(() => undefined),
        stopFallback: () => { ++stops; },
    });
    const startup = service.start();
    children[0].send({ type: "ready", capabilities: ["synthesis-v1"] });
    await startup;
    await assert.rejects(service.play("C:/fake/hung-legacy.wav"), /TTS fallback playback.*tempo limite/);
    assert.equal(stops, 1);
    assert.equal(children[0].killed, true);
});

test("stopPlayback cancela fallback sem aguardar close e stop rejeita operação remanescente", async t => {
    const { service, children } = mockedService(t, {
        playFallback: () => new Promise<void>(() => undefined),
    });
    const startup = service.start();
    children[0].send({ type: "ready", capabilities: ["synthesis-v1"] });
    await startup;
    let canceled = 0;
    const manual = service.play("C:/fake/legacy.wav", { onCancelled: () => { ++canceled; } });
    service.stopPlayback();
    await manual;
    assert.equal(canceled, 1);
    assert.equal(service.isReady(), true);
    const pending = service.play("C:/fake/legacy.wav");
    const rejected = assert.rejects(pending, /encerrado/);
    service.stop();
    await rejected;
    assert.equal(children[0].killed, true);
});
