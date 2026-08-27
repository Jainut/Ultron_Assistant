export type CalibrationDistance = "near" | "far";
export type CalibrationProfile = "standard" | "gate" | "quick";

export interface CalibrationCondition {
    readonly volumePercent: 25 | 50 | 100;
    readonly distance: CalibrationDistance;
}

export interface CalibrationSample extends CalibrationCondition {
    readonly kind: "echo" | "interruption";
    readonly valid: boolean;
    readonly expectedSpeech: boolean;
    readonly speechStart: boolean;
    readonly falseBarge: boolean;
    readonly playbackSeconds: number;
    readonly detectionLatencyMs?: number;
    readonly queueAgeMs?: number;
    readonly stopLatencyMs?: number;
}

export interface EchoTelemetrySample {
    readonly correlation: number;
    readonly residualRatio: number;
    readonly delayMs: number;
    readonly processingMs: number;
    readonly queueAgeMs: number;
}

export interface CalibrationCaptureConfiguration {
    readonly detector: "webrtcvad" | "rms";
    readonly echoReferenceEnabled: boolean;
    readonly maximumDelayMs: number;
    readonly correlationThreshold: number;
    readonly residualRatioThreshold: number;
}

export interface CalibrationOptions {
    readonly profile: CalibrationProfile;
    readonly attemptsPerCondition: number;
    readonly echoSecondsPerCondition: number;
    readonly outputPath?: string;
}

export interface CalibrationReportInput {
    readonly profile: CalibrationProfile;
    readonly createdAt: string;
    readonly samples: readonly CalibrationSample[];
    readonly echoTelemetry: readonly EchoTelemetrySample[];
    readonly capture: CalibrationCaptureConfiguration;
}

export const CALIBRATION_CONDITIONS: readonly CalibrationCondition[] = [
    { volumePercent: 25, distance: "near" },
    { volumePercent: 25, distance: "far" },
    { volumePercent: 50, distance: "near" },
    { volumePercent: 50, distance: "far" },
    { volumePercent: 100, distance: "near" },
    { volumePercent: 100, distance: "far" },
] as const;

export function parseCalibrationArgs(args: readonly string[]): CalibrationOptions {
    let profile: CalibrationProfile = "standard";
    let attemptsPerCondition = 5;
    let echoSecondsPerCondition = 10;
    let outputPath: string | undefined;

    const next = (index: number, option: string): string => {
        const value = args[index + 1]?.trim();
        if (!value || value.startsWith("--")) {
            throw new Error(`Valor ausente para ${option}.`);
        }
        return value;
    };

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        switch (argument) {
            case "--quick":
                profile = "quick";
                attemptsPerCondition = 1;
                echoSecondsPerCondition = 2;
                break;
            case "--gate":
                profile = "gate";
                attemptsPerCondition = 5;
                echoSecondsPerCondition = 300;
                break;
            case "--attempts":
                attemptsPerCondition = positiveInteger(
                    next(index, argument),
                    argument,
                );
                index += 1;
                break;
            case "--echo-seconds":
                echoSecondsPerCondition = positiveNumber(
                    next(index, argument),
                    argument,
                );
                index += 1;
                break;
            case "--output":
                outputPath = next(index, argument);
                index += 1;
                break;
            case "--help":
            case "-h":
                break;
            default:
                throw new Error(`Opção desconhecida: ${argument}`);
        }
    }

    return {
        profile,
        attemptsPerCondition,
        echoSecondsPerCondition,
        ...(outputPath ? { outputPath } : {}),
    };
}

function positiveInteger(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100) {
        throw new Error(`${option} deve ser um inteiro entre 1 e 100.`);
    }
    return parsed;
}

function positiveNumber(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3_600) {
        throw new Error(`${option} deve estar entre 0 e 3600 segundos.`);
    }
    return parsed;
}

function finite(values: readonly (number | undefined)[]): number[] {
    return values.filter(
        (value): value is number => typeof value === "number"
            && Number.isFinite(value)
            && value >= 0,
    );
}

function validDuration(sample: CalibrationSample): boolean {
    return Number.isFinite(sample.playbackSeconds) && sample.playbackSeconds > 0;
}

export function percentile(
    values: readonly number[],
    requestedPercentile: number,
): number | null {
    const ordered = finite(values).sort((left, right) => left - right);
    if (ordered.length === 0) return null;
    const position = (ordered.length - 1) * requestedPercentile / 100;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return round(ordered[lower] ?? 0);
    const fraction = position - lower;
    return round(
        (ordered[lower] ?? 0) * (1 - fraction)
        + (ordered[upper] ?? 0) * fraction,
    );
}

function round(value: number, digits = 3): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

export function buildCalibrationReport(input: CalibrationReportInput) {
    const validInterruptions = input.samples.filter(
        sample => sample.kind === "interruption"
            && sample.valid
            && sample.expectedSpeech
            && validDuration(sample),
    );
    const detectedInterruptions = validInterruptions.filter(
        sample => sample.speechStart,
    );
    const falseBargeEvents = input.samples.filter(
        sample => sample.falseBarge,
    ).length;
    const echoSamples = input.samples.filter(sample => sample.kind === "echo"
        && sample.valid && !sample.expectedSpeech && validDuration(sample));
    const echoFalseBargeEvents = echoSamples.filter(
        sample => sample.falseBarge,
    ).length;
    const echoPlaybackSeconds = echoSamples
        .reduce((total, sample) => total + sample.playbackSeconds, 0);
    const detectionRate = validInterruptions.length === 0
        ? 0
        : detectedInterruptions.length / validInterruptions.length;
    const detectionLatencies = finite(
        detectedInterruptions.map(sample => sample.detectionLatencyMs),
    );
    const stopLatencies = finite(
        detectedInterruptions.map(sample => sample.stopLatencyMs),
    );
    const queueAges = finite([
        ...detectedInterruptions.map(sample => sample.queueAgeMs),
        ...input.echoTelemetry.map(sample => sample.queueAgeMs),
    ]);

    const conditions = CALIBRATION_CONDITIONS.map(condition => {
        const attempts = validInterruptions.filter(sample =>
            sample.volumePercent === condition.volumePercent
            && sample.distance === condition.distance,
        );
        const detected = attempts.filter(sample => sample.speechStart).length;
        const echoSeconds = echoSamples
            .filter(sample => sample.volumePercent === condition.volumePercent
                && sample.distance === condition.distance)
            .reduce((total, sample) => total + sample.playbackSeconds, 0);
        return {
            ...condition,
            validInterruptionAttempts: attempts.length,
            detectedInterruptionAttempts: detected,
            echoPlaybackSeconds: round(echoSeconds),
            soakComplete: echoSeconds >= 300,
            detectionRate: attempts.length === 0
                ? 0
                : round(detected / attempts.length, 4),
        };
    });

    const matrixComplete = conditions.every(
        condition => condition.validInterruptionAttempts >= 5,
    );
    const soakComplete = conditions.every(condition => condition.soakComplete);
    const detectionP95Ms = percentile(detectionLatencies, 95);
    // A single fast sample cannot stand in for the other 29 detections. All
    // detections must carry timing/queue/stop telemetry before a pass is possible.
    const timingComplete = detectedInterruptions.length > 0
        && detectedInterruptions.every(sample => finite([
            sample.detectionLatencyMs,
            sample.queueAgeMs,
            sample.stopLatencyMs,
        ]).length === 3);
    const echoReferenceObserved = input.echoTelemetry.some(sample => finite([
        sample.correlation,
        sample.residualRatio,
        sample.delayMs,
        sample.processingMs,
        sample.queueAgeMs,
    ]).length === 5 && sample.correlation <= 1 && sample.residualRatio <= 1);
    const coverageComplete = matrixComplete && soakComplete
        && timingComplete && echoReferenceObserved;
    const criteriaPassed = falseBargeEvents === 0
        && detectionRate >= 0.95
        && detectionP95Ms !== null
        && detectionP95Ms < 200
        && input.capture.echoReferenceEnabled
        && input.capture.detector === "webrtcvad";
    const gate = !coverageComplete
        ? "inconclusive"
        : criteriaPassed ? "passed" : "failed";

    return {
        schemaVersion: 1,
        profile: input.profile,
        createdAt: input.createdAt,
        capture: input.capture,
        summary: {
            gate,
            matrixComplete,
            soakComplete,
            timingComplete,
            echoReferenceObserved,
            detectionLatencySamples: detectionLatencies.length,
            playbackStopLatencySamples: stopLatencies.length,
            echoPlaybackSeconds: round(echoPlaybackSeconds),
            falseBargeEvents,
            echoFalseBargeEvents,
            echoFalseBargeRate: echoSamples.length === 0
                ? 0
                : round(echoFalseBargeEvents / echoSamples.length, 4),
            echoFalseBargeEventsPerHour: echoPlaybackSeconds === 0
                ? 0
                : round(echoFalseBargeEvents * 3_600 / echoPlaybackSeconds),
            validInterruptionAttempts: validInterruptions.length,
            detectedInterruptionAttempts: detectedInterruptions.length,
            detectionRate: round(detectionRate, 4),
            detectionLatencyP50Ms: percentile(detectionLatencies, 50),
            detectionLatencyP95Ms: detectionP95Ms,
            playbackStopLatencyP50Ms: percentile(stopLatencies, 50),
            playbackStopLatencyP95Ms: percentile(stopLatencies, 95),
            captureQueueAgeP95Ms: percentile(queueAges, 95),
            echoCorrelationP50: percentile(
                input.echoTelemetry.map(sample => sample.correlation),
                50,
            ),
            echoResidualRatioP95: percentile(
                input.echoTelemetry.map(sample => sample.residualRatio),
                95,
            ),
            echoDelayP50Ms: percentile(
                input.echoTelemetry.map(sample => sample.delayMs),
                50,
            ),
            echoProcessingP95Ms: percentile(
                input.echoTelemetry.map(sample => sample.processingMs),
                95,
            ),
        },
        conditions,
    } as const;
}
