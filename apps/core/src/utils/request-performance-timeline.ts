import { performance } from "node:perf_hooks";

/**
 * Ordered names shared by voice, intent, tool and playback integrations.
 *
 * A timeline keeps monotonic timestamps. It deliberately does not reuse the
 * legacy PerformanceTracker because that tracker has process-global mutable
 * state and cannot safely correlate overlapping requests.
 */
export const requestMilestones = [
    "speech_start",
    "speech_end",
    "endpoint_detected",
    "transcription_start",
    "transcription_end",
    "intent_start",
    "intent_end",
    "tool_start",
    "tool_end",
    "tts_start",
    "audio_start",
    "audio_end",
] as const;

export type RequestMilestone = (typeof requestMilestones)[number];

export interface RequestCorrelation {
    requestId: string;
    conversationId?: string;
    toolCallId?: string;
}

export interface RequestTimelineMark extends RequestCorrelation {
    milestone: RequestMilestone;
    /** Monotonic milliseconds, normally sourced from performance.now(). */
    atMs: number;
}

export type RequestTimelineMarks = Partial<
    Record<RequestMilestone, RequestTimelineMark>
>;

export type RequestMetricKind = "duration" | "latency";

export type RequestMetricName =
    | "speech_duration"
    | "endpoint_delay"
    | "transcription_duration"
    | "intent_duration"
    | "tool_duration"
    | "audio_playback_duration"
    | "speech_end_to_action_start"
    | "speech_end_to_first_audio"
    | "tts_start_to_first_audio";

export interface RequestMetric extends RequestCorrelation {
    name: RequestMetricName;
    kind: RequestMetricKind;
    from: RequestMilestone;
    to: RequestMilestone;
    valueMs: number;
}

export interface RequestTimelineSnapshot {
    correlation: RequestCorrelation;
    marks: RequestTimelineMarks;
    metrics: RequestMetric[];
}

export interface MarkOptions {
    /** Primarily useful for deterministic tests and imported telemetry. */
    atMs?: number;
    /** Allows each tool event to carry its own correlation identifier. */
    toolCallId?: string;
    /** Milestones keep their first value by default, especially audio_start. */
    overwrite?: boolean;
}

export interface RequestPerformanceTimelineOptions {
    now?: () => number;
}

interface MetricDefinition {
    name: RequestMetricName;
    kind: RequestMetricKind;
    from: RequestMilestone;
    to: RequestMilestone;
}

const metricDefinitions: readonly MetricDefinition[] = [
    {
        name: "speech_duration",
        kind: "duration",
        from: "speech_start",
        to: "speech_end",
    },
    {
        name: "endpoint_delay",
        kind: "latency",
        from: "speech_end",
        to: "endpoint_detected",
    },
    {
        name: "transcription_duration",
        kind: "duration",
        from: "transcription_start",
        to: "transcription_end",
    },
    {
        name: "intent_duration",
        kind: "duration",
        from: "intent_start",
        to: "intent_end",
    },
    {
        name: "tool_duration",
        kind: "duration",
        from: "tool_start",
        to: "tool_end",
    },
    {
        name: "audio_playback_duration",
        kind: "duration",
        from: "audio_start",
        to: "audio_end",
    },
    {
        // In the current pipeline the first real action starts at tool_start.
        name: "speech_end_to_action_start",
        kind: "latency",
        from: "speech_end",
        to: "tool_start",
    },
    {
        name: "speech_end_to_first_audio",
        kind: "latency",
        from: "speech_end",
        to: "audio_start",
    },
    {
        name: "tts_start_to_first_audio",
        kind: "latency",
        from: "tts_start",
        to: "audio_start",
    },
];

/**
 * Per-request performance timeline suitable for overlapping conversations.
 *
 * `speech_duration` measures how long the user spoke. It must not be used as
 * response latency. Response latency starts at `speech_end`, as exposed by
 * `speech_end_to_action_start` and `speech_end_to_first_audio`.
 */
export class RequestPerformanceTimeline {
    private readonly correlation: RequestCorrelation;
    private readonly now: () => number;
    private readonly marks = new Map<RequestMilestone, RequestTimelineMark>();

    constructor(
        correlation: RequestCorrelation,
        options: RequestPerformanceTimelineOptions = {},
    ) {
        const requestId = correlation.requestId.trim();
        if (!requestId) {
            throw new Error("requestId é obrigatório para métricas por request.");
        }

        this.correlation = {
            requestId,
            conversationId: correlation.conversationId,
            toolCallId: correlation.toolCallId,
        };
        this.now = options.now ?? (() => performance.now());
    }

    mark(
        milestone: RequestMilestone,
        options: MarkOptions = {},
    ): RequestTimelineMark {
        const existing = this.marks.get(milestone);
        if (existing && !options.overwrite) return { ...existing };

        const mark: RequestTimelineMark = {
            ...this.correlation,
            toolCallId: options.toolCallId ?? this.correlation.toolCallId,
            milestone,
            atMs: options.atMs ?? this.now(),
        };

        if (!Number.isFinite(mark.atMs)) {
            throw new Error(`Timestamp inválido para ${milestone}.`);
        }

        this.marks.set(milestone, mark);
        return { ...mark };
    }

    getMark(milestone: RequestMilestone): RequestTimelineMark | undefined {
        const mark = this.marks.get(milestone);
        return mark ? { ...mark } : undefined;
    }

    has(milestone: RequestMilestone): boolean {
        return this.marks.has(milestone);
    }

    elapsed(
        from: RequestMilestone,
        to: RequestMilestone,
    ): number | undefined {
        const start = this.marks.get(from);
        const end = this.marks.get(to);
        if (!start || !end) return undefined;
        return end.atMs - start.atMs;
    }

    getMetrics(): RequestMetric[] {
        const metrics: RequestMetric[] = [];

        for (const definition of metricDefinitions) {
            const start = this.marks.get(definition.from);
            const end = this.marks.get(definition.to);
            if (!start || !end) continue;

            metrics.push({
                ...this.correlation,
                toolCallId:
                    end.toolCallId
                    ?? start.toolCallId
                    ?? this.correlation.toolCallId,
                ...definition,
                valueMs: end.atMs - start.atMs,
            });
        }

        return metrics;
    }

    snapshot(): RequestTimelineSnapshot {
        const marks: RequestTimelineMarks = {};
        for (const milestone of requestMilestones) {
            const mark = this.marks.get(milestone);
            if (mark) marks[milestone] = { ...mark };
        }

        return {
            correlation: { ...this.correlation },
            marks,
            metrics: this.getMetrics(),
        };
    }
}

/**
 * Small lifecycle registry for integration points that cannot pass the
 * timeline object directly. Completed requests are removed to avoid leaks.
 */
export class RequestPerformanceTimelineRegistry {
    private readonly timelines = new Map<string, RequestPerformanceTimeline>();
    private readonly now: () => number;

    constructor(options: RequestPerformanceTimelineOptions = {}) {
        this.now = options.now ?? (() => performance.now());
    }

    start(correlation: RequestCorrelation): RequestPerformanceTimeline {
        if (this.timelines.has(correlation.requestId)) {
            throw new Error(
                `Já existe uma timeline para requestId=${correlation.requestId}.`,
            );
        }

        const timeline = new RequestPerformanceTimeline(correlation, {
            now: this.now,
        });
        this.timelines.set(correlation.requestId, timeline);
        return timeline;
    }

    get(requestId: string): RequestPerformanceTimeline | undefined {
        return this.timelines.get(requestId);
    }

    finish(requestId: string): RequestTimelineSnapshot | undefined {
        const timeline = this.timelines.get(requestId);
        if (!timeline) return undefined;

        this.timelines.delete(requestId);
        return timeline.snapshot();
    }

    delete(requestId: string): boolean {
        return this.timelines.delete(requestId);
    }

    get size(): number {
        return this.timelines.size;
    }
}

export const requestPerformanceTimelines =
    new RequestPerformanceTimelineRegistry();
