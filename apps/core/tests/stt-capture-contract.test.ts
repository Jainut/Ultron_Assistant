import assert from "node:assert/strict";
import test from "node:test";

import {
    parseCaptureMessage,
    type CaptureEndpointMetrics,
} from "../src/speech/speech-to-text.ts";

const endpoint: CaptureEndpointMetrics = {
    reason: "silence",
    speechDurationMs: 1_240,
    voicedDurationMs: 890,
    endpointDelayMs: 300,
    silenceTargetMs: 280,
    detector: "rms",
};

test("contrato STT aceita métricas tipadas de endpoint", () => {
    assert.deepEqual(parseCaptureMessage({
        type: "speech_end",
        ...endpoint,
    }), {
        type: "speech_end",
        ...endpoint,
    });
    assert.deepEqual(parseCaptureMessage({
        type: "ready",
        detector: "rms",
        endpoint: { minimumMs: 280, targetMs: 320, maximumMs: 400 },
        echoReference: {
            enabled: true,
            maximumDelayMs: 250,
            correlationThreshold: 0.97,
            residualRatioThreshold: 0.18,
        },
    }), {
        type: "ready",
        detector: "rms",
        endpoint: { minimumMs: 280, targetMs: 320, maximumMs: 400 },
        echoReference: {
            enabled: true,
            maximumDelayMs: 250,
            correlationThreshold: 0.97,
            residualRatioThreshold: 0.18,
        },
    });
});

test("contrato STT aceita somente telemetria acústica saneada", () => {
    const event = {
        type: "echo_suppressed",
        correlation: 0.991,
        residualRatio: 0.08,
        delayMs: 80,
        generation: 3,
        processingMs: 0.72,
        queueAgeMs: 1.4,
    };
    assert.deepEqual(parseCaptureMessage(event), event);
    assert.equal(parseCaptureMessage({ ...event, correlation: 1.1 }), null);
    assert.equal(parseCaptureMessage({ ...event, generation: -1 }), null);
    assert.equal(parseCaptureMessage({ ...event, processingMs: Number.NaN }), null);
});

test("contrato de áudio antigo permanece compatível", () => {
    assert.deepEqual(parseCaptureMessage({
        type: "audio",
        path: "C:/Temp/utterance.wav",
    }), {
        type: "audio",
        path: "C:/Temp/utterance.wav",
    });
    assert.deepEqual(parseCaptureMessage({ type: "speech_start" }), {
        type: "speech_start",
    });
});

test("mensagens ou métricas inválidas não atravessam o contrato", () => {
    assert.equal(parseCaptureMessage({
        type: "speech_end",
        ...endpoint,
        endpointDelayMs: -1,
    }), null);
    assert.equal(parseCaptureMessage({
        type: "speech_end",
        ...endpoint,
        detector: "unknown",
    }), null);
    assert.equal(parseCaptureMessage({ type: "audio", path: "" }), null);
    assert.equal(parseCaptureMessage({ type: "unexpected" }), null);
});
