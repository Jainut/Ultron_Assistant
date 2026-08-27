import assert from "node:assert/strict";
import test from "node:test";

import {
    buildCalibrationReport,
    CALIBRATION_CONDITIONS,
    parseCalibrationArgs,
    percentile,
    type CalibrationReportInput,
    type CalibrationSample,
} from "../src/dev/barge-in-calibration.ts";
import {
    CalibrationCaptureClient,
    parseCalibrationCaptureMessage,
} from "../src/dev/calibration-capture-client.ts";

test("calibrador não escolhe arquivo de saída sem opt-in explícito", () => {
    assert.deepEqual(parseCalibrationArgs([]), {
        profile: "standard",
        attemptsPerCondition: 5,
        echoSecondsPerCondition: 10,
    });
    assert.equal(
        parseCalibrationArgs(["--output", "resultado.json"]).outputPath,
        "resultado.json",
    );
    assert.deepEqual(parseCalibrationArgs(["--quick"]), {
        profile: "quick",
        attemptsPerCondition: 1,
        echoSecondsPerCondition: 2,
    });
    assert.throws(() => parseCalibrationArgs(["--attempts", "0"]));
    assert.throws(() => parseCalibrationArgs(["--desconhecida"]));
});

test("parser transforma qualquer evento de áudio em falha sem reter path", () => {
    const parsed = parseCalibrationCaptureMessage({
        type: "audio",
        path: "C:/segredo/voz-do-usuario.wav",
        transcript: "conteúdo privado",
    });
    assert.deepEqual(parsed, { type: "privacy_violation" });
    const serialized = JSON.stringify(parsed);
    assert.doesNotMatch(serialized, /segredo|wav|conteúdo|path|transcript/i);
});

test("telemetria acústica aceita somente números finitos saneados", () => {
    const event = {
        type: "echo_suppressed",
        correlation: 0.99,
        residualRatio: 0.08,
        delayMs: 80,
        processingMs: 1.2,
        queueAgeMs: 2.4,
    };
    assert.deepEqual(parseCalibrationCaptureMessage(event), event);
    assert.equal(parseCalibrationCaptureMessage({
        ...event,
        correlation: Number.NaN,
    }), null);
    assert.equal(parseCalibrationCaptureMessage({
        ...event,
        residualRatio: 2,
    }), null);
});

test("falha fatal pós-ready permanece fail-fast entre rodadas", () => {
    const client = new CalibrationCaptureClient();
    const events: string[] = [];
    client.onMessage(message => events.push(message.type));
    const internal = client as unknown as {
        markFatal(error: Error): void;
    };
    internal.markFatal(new Error("capture closed"));
    internal.markFatal(new Error("duplicate"));

    assert.deepEqual(events, ["error"]);
    assert.throws(() => client.resume(), /capture closed/);
    assert.throws(() => client.setPlaybackActive(true), /capture closed/);
});

test("relatório calcula gate completo sem carregar conteúdo ou identificadores", () => {
    const samples: CalibrationSample[] = [];
    for (const condition of CALIBRATION_CONDITIONS) {
        samples.push({
            ...condition,
            kind: "echo",
            valid: true,
            expectedSpeech: false,
            speechStart: false,
            falseBarge: false,
            playbackSeconds: 300,
        });
        for (let attempt = 0; attempt < 5; attempt += 1) {
            samples.push({
                ...condition,
                kind: "interruption",
                valid: true,
                expectedSpeech: true,
                speechStart: true,
                falseBarge: false,
                playbackSeconds: 1.5,
                detectionLatencyMs: 75 + attempt,
                queueAgeMs: 2,
                stopLatencyMs: 18,
            });
        }
    }
    const report = buildCalibrationReport({
        profile: "gate",
        createdAt: "2026-08-22T12:00:00.000Z",
        samples,
        echoTelemetry: [{
            correlation: 0.99,
            residualRatio: 0.07,
            delayMs: 80,
            processingMs: 1.1,
            queueAgeMs: 2,
        }],
        capture: {
            detector: "webrtcvad",
            echoReferenceEnabled: true,
            maximumDelayMs: 250,
            correlationThreshold: 0.97,
            residualRatioThreshold: 0.18,
        },
    });

    assert.equal(report.summary.gate, "passed");
    assert.equal(report.summary.validInterruptionAttempts, 30);
    assert.equal(report.summary.detectionRate, 1);
    assert.equal(report.summary.echoPlaybackSeconds, 1_800);
    assert.equal(report.summary.detectionLatencyP95Ms, 79);
    assert.equal(report.conditions.length, 6);

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(
        serialized,
        /(?:\.wav|[A-Z]:[\\/]|transcript|deviceName|audioPath|spokenText)/i,
    );
});

test("cobertura curta permanece inconclusiva e percentis são determinísticos", () => {
    assert.equal(percentile([30, 10, 20, 40], 50), 25);
    assert.equal(percentile([], 95), null);
    const report = buildCalibrationReport({
        profile: "quick",
        createdAt: "2026-08-22T12:00:00.000Z",
        samples: [],
        echoTelemetry: [],
        capture: {
            detector: "webrtcvad",
            echoReferenceEnabled: true,
            maximumDelayMs: 250,
            correlationThreshold: 0.97,
            residualRatioThreshold: 0.18,
        },
    });
    assert.equal(report.summary.gate, "inconclusive");
});

function completeReportInput(): CalibrationReportInput {
    return {
        profile: "gate",
        createdAt: "2026-08-27T12:00:00.000Z",
        samples: CALIBRATION_CONDITIONS.flatMap(condition => [
            {
                ...condition,
                kind: "echo" as const,
                valid: true,
                expectedSpeech: false,
                speechStart: false,
                falseBarge: false,
                playbackSeconds: 300,
            },
            ...Array.from({ length: 5 }, () => ({
                ...condition,
                kind: "interruption" as const,
                valid: true,
                expectedSpeech: true,
                speechStart: true,
                falseBarge: false,
                playbackSeconds: 1.5,
                detectionLatencyMs: 85,
                queueAgeMs: 2,
                stopLatencyMs: 18,
            })),
        ]),
        echoTelemetry: [{
            correlation: 0.99,
            residualRatio: 0.08,
            delayMs: 80,
            processingMs: 1,
            queueAgeMs: 2,
        }],
        capture: {
            detector: "webrtcvad",
            echoReferenceEnabled: true,
            maximumDelayMs: 250,
            correlationThreshold: 0.97,
            residualRatioThreshold: 0.18,
        },
    };
}

test("gate não aprova a matriz com latências ausentes na maioria das detecções", () => {
    const input = completeReportInput();
    const samples = input.samples.map((sample, index) => ({
        ...sample,
        ...(index > 1 ? { detectionLatencyMs: undefined } : {}),
    }));
    const report = buildCalibrationReport({ ...input, samples });
    assert.equal(report.summary.matrixComplete, true);
    assert.equal(report.summary.soakComplete, true);
    assert.equal(report.summary.timingComplete, false);
    assert.equal(report.summary.gate, "inconclusive");
});

test("gate exige soak em todos os volumes/distâncias e ignora duração não finita", () => {
    const input = completeReportInput();
    const samples = input.samples.map(sample => ({
        ...sample,
        ...(sample.kind === "echo" ? {
            playbackSeconds: sample.volumePercent === 25 && sample.distance === "near" ? 1_800 : 0,
        } : {}),
    }));
    const report = buildCalibrationReport({ ...input, samples });
    assert.equal(report.summary.echoPlaybackSeconds, 1_800);
    assert.equal(report.summary.soakComplete, false);
    assert.equal(report.summary.gate, "inconclusive");

    for (const duration of [Number.NaN, Number.POSITIVE_INFINITY, -10]) {
        const invalid = buildCalibrationReport({
            ...input,
            samples: input.samples.map(sample => ({ ...sample, playbackSeconds: duration })),
        });
        assert.equal(invalid.summary.echoPlaybackSeconds, 0);
        assert.equal(invalid.summary.validInterruptionAttempts, 0);
        assert.equal(invalid.summary.gate, "inconclusive");
    }
});

test("referência habilitada sem telemetria observada não comprova o gate acústico", () => {
    const report = buildCalibrationReport({ ...completeReportInput(), echoTelemetry: [] });
    assert.equal(report.summary.echoReferenceObserved, false);
    assert.equal(report.summary.gate, "inconclusive");
});

test("gate com cobertura completa reprova falsos barges ou latência alta", () => {
    const input = completeReportInput();
    for (const patch of [{ falseBarge: true }, { detectionLatencyMs: 250 }]) {
        const report = buildCalibrationReport({
            ...input,
            samples: input.samples.map(sample => ({ ...sample, ...patch })),
        });
        assert.equal(report.summary.gate, "failed");
    }
});
