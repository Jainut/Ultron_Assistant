import assert from "node:assert/strict";
import test from "node:test";
import {
    RequestPerformanceTimeline,
    RequestPerformanceTimelineRegistry,
    type RequestMetricName,
} from "../src/utils/request-performance-timeline.ts";

function metric(
    timeline: RequestPerformanceTimeline,
    name: RequestMetricName,
) {
    return timeline.getMetrics().find((entry) => entry.name === name);
}

test("separa duração da fala das latências medidas depois de speech_end", () => {
    const timeline = new RequestPerformanceTimeline({
        requestId: "req-1",
        conversationId: "conversation-7",
        toolCallId: "tool-3",
    });

    timeline.mark("speech_start", { atMs: 100 });
    timeline.mark("speech_end", { atMs: 1_100 });
    timeline.mark("endpoint_detected", { atMs: 1_400 });
    timeline.mark("transcription_start", { atMs: 1_400 });
    timeline.mark("transcription_end", { atMs: 1_560 });
    timeline.mark("intent_start", { atMs: 1_560 });
    timeline.mark("intent_end", { atMs: 1_590 });
    timeline.mark("tool_start", { atMs: 1_600 });
    timeline.mark("tts_start", { atMs: 1_620 });
    timeline.mark("tool_end", { atMs: 1_780 });
    timeline.mark("audio_start", { atMs: 2_000 });
    timeline.mark("audio_end", { atMs: 2_700 });

    assert.deepEqual(metric(timeline, "speech_duration"), {
        requestId: "req-1",
        conversationId: "conversation-7",
        toolCallId: "tool-3",
        name: "speech_duration",
        kind: "duration",
        from: "speech_start",
        to: "speech_end",
        valueMs: 1_000,
    });
    assert.equal(
        metric(timeline, "speech_end_to_action_start")?.valueMs,
        500,
    );
    assert.equal(
        metric(timeline, "speech_end_to_first_audio")?.valueMs,
        900,
    );
    assert.equal(metric(timeline, "tts_start_to_first_audio")?.valueMs, 380);
    assert.equal(metric(timeline, "endpoint_delay")?.valueMs, 300);
    assert.equal(metric(timeline, "endpoint_delay")?.kind, "latency");
    assert.equal(metric(timeline, "transcription_duration")?.valueMs, 160);
    assert.equal(metric(timeline, "intent_duration")?.valueMs, 30);
    assert.equal(metric(timeline, "tool_duration")?.valueMs, 180);
    assert.equal(metric(timeline, "audio_playback_duration")?.valueMs, 700);

    assert.equal(
        metric(timeline, "speech_end_to_action_start")?.kind,
        "latency",
    );
    assert.equal(
        metric(timeline, "speech_end_to_first_audio")?.kind,
        "latency",
    );
});

test("retrodata speech_end a partir do instante real de endpoint", () => {
    const timeline = new RequestPerformanceTimeline(
        { requestId: "req-endpoint" },
        { now: () => 1_425 },
    );
    timeline.mark("speech_start", { atMs: 100 });

    const detected = timeline.mark("endpoint_detected");
    timeline.mark("speech_end", {
        atMs: detected.atMs - 325,
        overwrite: true,
    });

    assert.equal(timeline.getMark("endpoint_detected")?.atMs, 1_425);
    assert.equal(timeline.getMark("speech_end")?.atMs, 1_100);
    assert.equal(metric(timeline, "speech_duration")?.valueMs, 1_000);
    assert.deepEqual(metric(timeline, "endpoint_delay"), {
        requestId: "req-endpoint",
        conversationId: undefined,
        toolCallId: undefined,
        name: "endpoint_delay",
        kind: "latency",
        from: "speech_end",
        to: "endpoint_detected",
        valueMs: 325,
    });
});

test("preserva o primeiro audio_start e carrega correlação por tool call", () => {
    const timeline = new RequestPerformanceTimeline({
        requestId: "req-first-audio",
        conversationId: "conversation-8",
    });

    timeline.mark("speech_end", { atMs: 20 });
    timeline.mark("tool_start", { atMs: 25, toolCallId: "tool-light" });
    timeline.mark("audio_start", { atMs: 40, toolCallId: "tool-light" });
    timeline.mark("audio_start", { atMs: 90, toolCallId: "later-chunk" });

    assert.equal(timeline.getMark("audio_start")?.atMs, 40);
    assert.equal(
        metric(timeline, "speech_end_to_first_audio")?.toolCallId,
        "tool-light",
    );
    assert.equal(
        metric(timeline, "speech_end_to_action_start")?.toolCallId,
        "tool-light",
    );
});

test("omite métricas incompletas sem inventar zero", () => {
    const timeline = new RequestPerformanceTimeline({ requestId: "req-partial" });
    timeline.mark("speech_start", { atMs: 10 });
    timeline.mark("intent_start", { atMs: 12 });

    assert.equal(timeline.elapsed("speech_start", "speech_end"), undefined);
    assert.deepEqual(timeline.getMetrics(), []);
    assert.equal(timeline.snapshot().marks.speech_start?.atMs, 10);
});

test("registry isola requests concorrentes e remove a concluída", () => {
    let currentTime = 0;
    const registry = new RequestPerformanceTimelineRegistry({
        now: () => currentTime,
    });
    const first = registry.start({
        requestId: "req-a",
        conversationId: "conversation-a",
    });
    const second = registry.start({
        requestId: "req-b",
        conversationId: "conversation-b",
    });

    currentTime = 10;
    first.mark("speech_end");
    currentTime = 25;
    second.mark("speech_end");
    currentTime = 40;
    first.mark("tool_start");

    const snapshot = registry.finish("req-a");
    assert.equal(snapshot?.correlation.conversationId, "conversation-a");
    assert.equal(
        snapshot?.metrics.find(
            (entry) => entry.name === "speech_end_to_action_start",
        )?.valueMs,
        30,
    );
    assert.equal(registry.get("req-a"), undefined);
    assert.equal(registry.get("req-b"), second);
    assert.equal(registry.size, 1);
});

test("rejeita requestId vazio, timestamp inválido e duplicidade no registry", () => {
    assert.throws(
        () => new RequestPerformanceTimeline({ requestId: "  " }),
        /requestId é obrigatório/,
    );

    const timeline = new RequestPerformanceTimeline({ requestId: "req-valid" });
    assert.throws(
        () => timeline.mark("speech_start", { atMs: Number.NaN }),
        /Timestamp inválido/,
    );

    const registry = new RequestPerformanceTimelineRegistry();
    registry.start({ requestId: "req-duplicate" });
    assert.throws(
        () => registry.start({ requestId: "req-duplicate" }),
        /Já existe uma timeline/,
    );
});
