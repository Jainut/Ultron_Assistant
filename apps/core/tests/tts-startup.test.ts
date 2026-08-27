import assert from "node:assert/strict";
import test from "node:test";
import type { spawn } from "node:child_process";

import { parseTtsStartupMetrics, TextToSpeechService } from "../src/speech/text-to-speech.ts";
import { VoiceServiceChild } from "./support/voice-service-child.ts";

function mockedService() {
    const children: VoiceServiceChild[] = [];
    const service = new TextToSpeechService({
        spawnService: (() => {
            const child = new VoiceServiceChild();
            children.push(child);
            return child.asProcess();
        }) as unknown as typeof spawn,
    });
    return { service, children };
}

const ready = { type: "ready", capabilities: ["synthesis-v1", "playback-v1"] };

test("startup TTS é single-flight e só resolve após ready real", async () => {
    const { service, children } = mockedService();
    try {
        const first = service.start();
        const second = service.start();
        assert.equal(first, second);
        assert.equal(children.length, 1);
        let resolved = false;
        void first.then(() => { resolved = true; });
        await Promise.resolve();
        assert.equal(resolved, false);
        children[0].send(ready);
        await Promise.all([first, second]);
        assert.equal(service.isPersistentPlaybackAvailable(), true);
    } finally {
        service.stop();
    }
});

test("erro no startup TTS rejeita todos os consumidores e permite tentativa nova", async () => {
    const { service, children } = mockedService();
    try {
        const first = service.start();
        const firstRejected = assert.rejects(first, /spawn failed/);
        const secondRejected = assert.rejects(service.start(), /spawn failed/);
        children[0].emit("error", new Error("spawn failed"));
        await Promise.all([firstRejected, secondRejected]);
        assert.equal(children[0].killed, true);

        const retry = service.start();
        assert.equal(children.length, 2);
        children[1].send(ready);
        await retry;
        children[0].close(1);
        assert.equal(service.isPersistentPlaybackAvailable(), true);
    } finally {
        service.stop();
    }
});

test("stop durante startup TTS rejeita sem aguardar close e ignora ready tardio", async () => {
    const { service, children } = mockedService();
    try {
        const pending = service.start();
        const rejected = assert.rejects(pending, /encerrado/);
        service.stop();
        await rejected;

        const retry = service.start();
        children[0].send(ready);
        assert.equal(service.isPersistentPlaybackAvailable(), false);
        children[1].send(ready);
        await retry;
        children[0].close(1);
        assert.equal(service.isPersistentPlaybackAvailable(), true);
    } finally {
        service.stop();
    }
});

test("close e erro fatal de protocolo antes de ready não deixam startup pendurado", async () => {
    for (const event of ["close", "protocol"] as const) {
        const { service, children } = mockedService();
        try {
            const pending = service.start();
            const rejected = assert.rejects(pending, /encerrou|warm-up failed/);
            if (event === "close") children[0].close(1);
            else children[0].send({ type: "error", error: "warm-up failed" });
            await rejected;
        } finally {
            service.stop();
        }
    }
});

test("timeout de startup TTS termina processo sem confirmar prontidão", async () => {
    const child = new VoiceServiceChild();
    const service = new TextToSpeechService({
        spawnService: (() => child.asProcess()) as unknown as typeof spawn,
        startupTimeoutMs: 10,
    });
    try {
        await assert.rejects(service.start(), /tempo limite/);
        assert.equal(child.killed, true);
        assert.equal(service.isPersistentPlaybackAvailable(), false);
    } finally {
        service.stop();
    }
});

test("erro pós-ready rejeita síntese e playback em curso sem esperar close", async () => {
    const { service, children } = mockedService();
    try {
        const startup = service.start();
        const child = children[0];
        child.send(ready);
        await startup;
        const synthesis = service.synthesize("Frase fixa de teste");
        const playback = service.play("C:/fake/voice.wav");
        const play = child.messages.find(message => message.type === "play");
        child.send({ id: play?.id, type: "playback_started" });
        const rejectedSynthesis = assert.rejects(synthesis, /late error/);
        const rejectedPlayback = assert.rejects(playback, /late error/);
        child.emit("error", new Error("late error"));
        await Promise.all([rejectedSynthesis, rejectedPlayback]);
        assert.equal(service.isPersistentPlaybackAvailable(), false);
        assert.equal(child.killed, true);
    } finally {
        service.stop();
    }
});

test("EPIPE no stdin TTS também rejeita síntese pendente", async () => {
    const { service, children } = mockedService();
    try {
        const startup = service.start();
        const child = children[0];
        child.send(ready);
        await startup;
        const synthesis = service.synthesize("Frase fixa de teste");
        const rejected = assert.rejects(synthesis, /EPIPE/);
        child.stdin.emit("error", new Error("EPIPE"));
        await rejected;
    } finally {
        service.stop();
    }
});

test("modo de calibração não transforma falha antes do áudio em fallback com relógio impreciso", async () => {
    const child = new VoiceServiceChild();
    const service = new TextToSpeechService({
        spawnService: (() => child.asProcess()) as unknown as typeof spawn,
        requirePersistentPlayback: true,
    });
    try {
        await assert.rejects(service.play("C:/fake/voice.wav"), /player persistente/);
        const startup = service.start();
        child.send(ready);
        await startup;
        let playbackStarted = false;
        const playback = service.play("C:/fake/voice.wav", {
            onStarted: () => { playbackStarted = true; },
        });
        const rejected = assert.rejects(playback, /player failed/);
        const play = child.messages.find(message => message.type === "play");
        child.send({ id: play?.id, type: "error", error: "player failed" });
        await rejected;
        assert.equal(playbackStarted, false);
    } finally {
        service.stop();
    }
});

test("telemetria de startup do TTS aceita protocolo novo e ignora campos extras", () => {
    assert.deepEqual(
        parseTtsStartupMetrics({
            stdlibImportsMs: 1.25,
            voiceEngineImportMs: 18_545,
            voiceDependenciesMs: 12_345,
            pipelineInitializationMs: 6_200,
            kokoroWarmUpMs: 1_700,
            effectsWarmUpMs: 5_700,
            warmUpTotalMs: 7_400,
            serviceReadyMs: 23_000,
            futureMetricMs: 42,
        }),
        {
            stdlibImportsMs: 1.25,
            voiceEngineImportMs: 18_545,
            voiceDependenciesMs: 12_345,
            pipelineInitializationMs: 6_200,
            kokoroWarmUpMs: 1_700,
            effectsWarmUpMs: 5_700,
            warmUpTotalMs: 7_400,
            serviceReadyMs: 23_000,
        },
    );
});

test("telemetria de startup do TTS mantém compatibilidade e rejeita valores inválidos", () => {
    assert.equal(parseTtsStartupMetrics(undefined), null);
    assert.equal(parseTtsStartupMetrics([12]), null);
    assert.equal(parseTtsStartupMetrics({ legacy: true }), null);
    assert.equal(parseTtsStartupMetrics({
        stdlibImportsMs: "1",
        pipelineInitializationMs: -1,
        effectsWarmUpMs: Number.POSITIVE_INFINITY,
    }), null);
    assert.deepEqual(parseTtsStartupMetrics({
        stdlibImportsMs: 0,
        playerImportMs: Number.NaN,
    }), {
        stdlibImportsMs: 0,
    });
});
