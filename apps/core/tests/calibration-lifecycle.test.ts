import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import test from "node:test";

import {
    assertCalibrationIsolation,
    GuidedPlayback,
    waitWithAbort,
} from "../src/dev/calibrate-barge-in.ts";
import {
    CalibrationCaptureClient,
    parseCalibrationCaptureMessage,
    type CalibrationCaptureListener,
    type CalibrationCaptureMessage,
} from "../src/dev/calibration-capture-client.ts";
import type { PlaybackOptions, TextToSpeechService } from "../src/speech/text-to-speech.ts";
import { VoiceServiceChild } from "./support/voice-service-child.ts";

const captureReady = {
    type: "ready",
    observeOnly: true,
    detector: "webrtcvad",
    echoReference: {
        enabled: true,
        maximumDelayMs: 250,
        correlationThreshold: 0.97,
        residualRatioThreshold: 0.18,
    },
} as const;

function mockCapture() {
    const child = new VoiceServiceChild();
    let spawns = 0;
    const client = new CalibrationCaptureClient({
        spawnService: ((_executable, _args, options) => {
            spawns += 1;
            assert.equal(options?.env?.ULTRON_CAPTURE_OBSERVE_ONLY, "1");
            return child.asProcess();
        }) as typeof spawn,
    });
    return { client, child, spawns: () => spawns };
}

test("capturador exige confirmação observeOnly antes de aceitar ready", () => {
    assert.deepEqual(parseCalibrationCaptureMessage(captureReady), captureReady);
    assert.deepEqual(parseCalibrationCaptureMessage({ ...captureReady, observeOnly: false }), {
        type: "privacy_violation",
    });
    const { observeOnly: _ignored, ...legacyReady } = captureReady;
    assert.deepEqual(parseCalibrationCaptureMessage(legacyReady), { type: "privacy_violation" });
});

test("captura inicia só um processo privado e só resolve após handshake", async () => {
    const { client, child, spawns } = mockCapture();
    try {
        const first = client.start();
        const second = client.start();
        assert.equal(spawns(), 1);
        child.send(captureReady);
        assert.deepEqual(await first, captureReady);
        assert.deepEqual(await second, captureReady);
    } finally {
        client.stop();
    }
});

test("parar captura durante startup não espera close nem deixa timeout vivo", async () => {
    const { client, child } = mockCapture();
    const pending = client.start();
    const rejected = assert.rejects(pending, { name: "AbortError" });
    client.stop();
    await rejected;
    assert.equal(child.killed, true);
    child.send(captureReady);
    assert.throws(() => client.resume(), /não está disponível/);
});

test("captura fatal pós-ready é persistida e não vaza path/transcrição", async () => {
    for (const failure of ["close", "error", "audio", "stdin"] as const) {
        const { client, child } = mockCapture();
        const events: CalibrationCaptureMessage[] = [];
        client.onMessage(event => events.push(event));
        try {
            const startup = client.start();
            child.send(captureReady);
            await startup;
            if (failure === "close") child.close(1);
            if (failure === "error") child.emit("error", new Error("private device path"));
            if (failure === "stdin") child.stdin.emit("error", new Error("private EPIPE"));
            if (failure === "audio") child.send({
                type: "audio", path: "C:/private/voice.wav", transcript: "private phrase",
            });
            assert.throws(() => client.resume());
            await assert.rejects(client.start());
            assert.doesNotMatch(JSON.stringify(events), /private|\.wav|transcript/);
            assert.equal(events.filter(event => event.type === "error"
                || event.type === "privacy_violation").length, 1);
        } finally {
            client.stop();
        }
    }
});

test("ready legado falha antes de qualquer comando resume", async () => {
    const { client, child } = mockCapture();
    try {
        const startup = client.start();
        const rejected = assert.rejects(startup, /modo privado/);
        child.send({ ...captureReady, observeOnly: false });
        await rejected;
        assert.equal(child.killed, true);
        assert.equal(child.messages.some(message => message.type === "resume"), false);
    } finally {
        client.stop();
    }
});

test("isolamento verifica Whisper mesmo se HUD migrou de porta", async () => {
    const probed: number[] = [];
    await assert.rejects(assertCalibrationIsolation({ hudPort: 8787, whisperPort: 8178 }, async port => {
        probed.push(port);
        return port === 8178;
    }), /8178/);
    assert.deepEqual(probed.sort(), [8178, 8787]);
    await assertCalibrationIsolation({ hudPort: 8787, whisperPort: 8178 }, async () => false);
});

test("abort durante startup encerra espera imediatamente mesmo sem ready", async () => {
    const controller = new AbortController();
    const neverReady = new Promise<never>(() => undefined);
    const waiting = waitWithAbort(neverReady, controller.signal);
    const rejected = assert.rejects(waiting, { name: "AbortError" });
    controller.abort();
    await rejected;
});

function playbackFixture() {
    const listeners = new Set<CalibrationCaptureListener>();
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    let finishPlayback: (() => void) | undefined;
    let stops = 0;
    const capture = {
        onMessage: (listener: CalibrationCaptureListener) => {
            listeners.add(listener);
            return (): void => { listeners.delete(listener); };
        },
        resume: () => undefined,
        pause: () => undefined,
        setPlaybackActive: (_active: boolean) => undefined,
        startPlaybackReference: () => undefined,
        endPlaybackReference: () => undefined,
    };
    const tts = {
        synthesize: async (_text: string, _signal?: AbortSignal) => "C:/nonexistent-calibration-fixture.wav",
        play: async (_path: string, options: PlaybackOptions) => {
            const complete = new Promise<void>(resolve => { finishPlayback = resolve; });
            options.onStarted?.();
            resolveStarted();
            await complete;
        },
        stopPlayback: () => { stops += 1; finishPlayback?.(); },
    };
    return {
        capture,
        tts,
        started,
        stops: () => stops,
        emit: (message: CalibrationCaptureMessage): void => {
            for (const listener of listeners) listener(message);
        },
    };
}

test("calibrador interrompe fila real com speech_start e coleta só métricas", async () => {
    const fixture = playbackFixture();
    const controller = new AbortController();
    const playback = new GuidedPlayback(fixture.tts as unknown as TextToSpeechService, fixture.capture, controller.signal);
    try {
        const run = playback.runEchoPlayback();
        await fixture.started;
        fixture.emit({ type: "speech_start", playback: true, detectionLatencyMs: 85, queueAgeMs: 2 });
        const observation = await run;
        assert.equal(observation.speechStart, true);
        assert.equal(observation.detectionLatencyMs, 85);
        assert.equal(fixture.stops() > 0, true);
        assert.doesNotMatch(JSON.stringify(observation), /\.wav|transcript|audioPath/);
    } finally {
        await playback.stop();
    }
});

test("erro de captura e SIGINT após playback_started não deixam deferred pendente", async () => {
    for (const failure of ["capture", "abort"] as const) {
        const fixture = playbackFixture();
        const controller = new AbortController();
        const playback = new GuidedPlayback(fixture.tts as unknown as TextToSpeechService, fixture.capture, controller.signal);
        try {
            const run = playback.runEchoPlayback();
            const rejected = assert.rejects(run);
            await fixture.started;
            if (failure === "capture") fixture.emit({ type: "error" });
            else controller.abort();
            await rejected;
            await assert.rejects(playback.runEchoPlayback());
            assert.equal(fixture.stops() > 0, true);
        } finally {
            await playback.stop();
        }
    }
});

test("abort antes do primeiro áudio cancela síntese da fila sem rejeição órfã", async () => {
    const fixture = playbackFixture();
    const controller = new AbortController();
    fixture.tts.synthesize = async (_text, signal) => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const playback = new GuidedPlayback(fixture.tts as unknown as TextToSpeechService, fixture.capture, controller.signal);
    try {
        const run = playback.runEchoPlayback();
        const rejected = assert.rejects(run, { name: "AbortError" });
        controller.abort();
        await rejected;
    } finally {
        await playback.stop();
    }
});

test("falha ao enviar referência acústica invalida rodada mesmo com fila tolerante", async () => {
    const fixture = playbackFixture();
    fixture.capture.startPlaybackReference = (): never => { throw new Error("reference unavailable"); };
    const controller = new AbortController();
    const playback = new GuidedPlayback(fixture.tts as unknown as TextToSpeechService, fixture.capture, controller.signal);
    try {
        await assert.rejects(playback.runEchoPlayback(), /reference unavailable/);
    } finally {
        await playback.stop();
    }
});
