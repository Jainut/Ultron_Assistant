import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

import { runtimeConfig, servicePath } from "../config/runtime.ts";
import type { PlaybackReference } from "../speech/playback-reference.ts";

export type CalibrationCaptureMessage =
    | {
        readonly type: "ready";
        readonly observeOnly: true;
        readonly detector: "webrtcvad" | "rms";
        readonly echoReference: {
            readonly enabled: boolean;
            readonly maximumDelayMs: number;
            readonly correlationThreshold: number;
            readonly residualRatioThreshold: number;
        };
    }
    | {
        readonly type: "speech_start";
        readonly playback: boolean;
        readonly detectionLatencyMs?: number;
        readonly queueAgeMs?: number;
    }
    | {
        readonly type: "speech_end";
        readonly endpointDelayMs: number;
    }
    | {
        readonly type: "echo_suppressed";
        readonly correlation: number;
        readonly residualRatio: number;
        readonly delayMs: number;
        readonly processingMs: number;
        readonly queueAgeMs: number;
    }
    | { readonly type: "privacy_violation" }
    | { readonly type: "error" };

export type CalibrationCaptureListener = (
    message: CalibrationCaptureMessage,
) => void;

type CaptureReady = Extract<CalibrationCaptureMessage, { type: "ready" }>;

export interface CalibrationCaptureClientOptions {
    spawnService?: typeof spawn;
    startupTimeoutMs?: number;
}

export function parseCalibrationCaptureMessage(
    value: unknown,
): CalibrationCaptureMessage | null {
    if (!isRecord(value) || typeof value.type !== "string") return null;

    if (value.type === "audio") {
        // Never retain or surface a microphone path. Any audio event means the
        // observe-only invariant was violated and the session must stop.
        return { type: "privacy_violation" };
    }
    if (value.type === "error") return { type: "error" };
    if (value.type === "ready") {
        // Do not unpause a legacy/misconfigured capturer that might save a WAV.
        if (value.observeOnly !== true) return { type: "privacy_violation" };
        const detector = value.detector;
        const echoReference = value.echoReference;
        if (
            (detector !== "webrtcvad" && detector !== "rms")
            || !isRecord(echoReference)
            || typeof echoReference.enabled !== "boolean"
            || !nonNegative(echoReference.maximumDelayMs)
            || !unitInterval(echoReference.correlationThreshold)
            || !unitInterval(echoReference.residualRatioThreshold)
        ) {
            return null;
        }
        return {
            type: "ready",
            observeOnly: true,
            detector,
            echoReference: {
                enabled: echoReference.enabled,
                maximumDelayMs: echoReference.maximumDelayMs,
                correlationThreshold: echoReference.correlationThreshold,
                residualRatioThreshold: echoReference.residualRatioThreshold,
            },
        };
    }
    if (value.type === "speech_start") {
        if (typeof value.playback !== "boolean") return null;
        return {
            type: "speech_start",
            playback: value.playback,
            ...(nonNegative(value.detectionLatencyMs)
                ? { detectionLatencyMs: value.detectionLatencyMs }
                : {}),
            ...(nonNegative(value.queueAgeMs)
                ? { queueAgeMs: value.queueAgeMs }
                : {}),
        };
    }
    if (value.type === "speech_end") {
        return nonNegative(value.endpointDelayMs)
            ? { type: "speech_end", endpointDelayMs: value.endpointDelayMs }
            : null;
    }
    if (value.type === "echo_suppressed") {
        if (
            !unitInterval(value.correlation)
            || !unitInterval(value.residualRatio)
            || !nonNegative(value.delayMs)
            || !nonNegative(value.processingMs)
            || !nonNegative(value.queueAgeMs)
        ) {
            return null;
        }
        return {
            type: "echo_suppressed",
            correlation: value.correlation,
            residualRatio: value.residualRatio,
            delayMs: value.delayMs,
            processingMs: value.processingMs,
            queueAgeMs: value.queueAgeMs,
        };
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonNegative(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function unitInterval(value: unknown): value is number {
    return nonNegative(value) && value <= 1;
}

export class CalibrationCaptureClient {
    private child: ChildProcessWithoutNullStreams | null = null;
    private readonly listeners = new Set<CalibrationCaptureListener>();
    private readyMessage: Extract<CalibrationCaptureMessage, { type: "ready" }>
        | null = null;
    private fatalError: Error | null = null;
    private readonly intentionalStops = new WeakSet<ChildProcessWithoutNullStreams>();
    private startupPromise: Promise<CaptureReady> | null = null;
    private cancelStartup: ((error: Error) => void) | null = null;

    constructor(private readonly options: CalibrationCaptureClientOptions = {}) {}

    onMessage(listener: CalibrationCaptureListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async start(): Promise<Extract<CalibrationCaptureMessage, { type: "ready" }>> {
        if (this.fatalError) throw this.fatalError;
        if (this.startupPromise) return this.startupPromise;
        if (this.child) {
            if (this.readyMessage) return this.readyMessage;
            throw new Error("O capturador de calibração já está iniciando.");
        }

        const captureDirectory = servicePath("speech-input");
        const pythonExecutable = path.join(
            captureDirectory,
            ".venv",
            "Scripts",
            "python.exe",
        );
        const captureScript = path.join(
            captureDirectory,
            "src",
            "capture_service.py",
        );

        const child = (this.options.spawnService ?? spawn)(pythonExecutable, ["-u", captureScript], {
            cwd: captureDirectory,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                PYTHONIOENCODING: "utf-8",
                PYTHONUTF8: "1",
                PYTHONUNBUFFERED: "1",
                ULTRON_CAPTURE_OBSERVE_ONLY: "1",
                ULTRON_ENDPOINT_MIN_MS: String(runtimeConfig.sttEndpointMinMs),
                ULTRON_ENDPOINT_TARGET_MS: String(
                    runtimeConfig.sttEndpointTargetMs,
                ),
                ULTRON_ENDPOINT_MAX_MS: String(runtimeConfig.sttEndpointMaxMs),
                ULTRON_MIN_VOICED_SECONDS: String(
                    runtimeConfig.sttMinimumVoicedMs / 1_000,
                ),
                ULTRON_VAD_ENABLED: runtimeConfig.sttVadEnabled ? "1" : "0",
                ULTRON_VAD_MODE: String(runtimeConfig.sttVadMode),
                ULTRON_ECHO_TELEMETRY_INTERVAL_MS: "250",
            },
        });
        this.child = child;

        const startupPromise = new Promise<CaptureReady>((resolve, reject) => {
            let settled = false;
            const cancelStartup = (error: Error): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (this.cancelStartup === cancelStartup) this.cancelStartup = null;
                reject(error);
            };
            this.cancelStartup = cancelStartup;
            const failStartup = (error: Error): void => {
                if (settled) return;
                cancelStartup(error);
                this.markFatal(error);
                child.kill();
            };
            const configuredTimeout = this.options.startupTimeoutMs ?? 10_000;
            const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
                ? configuredTimeout : 10_000;
            const timeout = setTimeout(() => {
                failStartup(new Error(
                    "O capturador de calibração excedeu o tempo limite de inicialização.",
                ));
            }, timeoutMs);

            const lines = createInterface({ input: child.stdout });
            lines.on("line", line => {
                if (this.child !== child || this.fatalError) return;
                let parsed: CalibrationCaptureMessage | null = null;
                try {
                    parsed = parseCalibrationCaptureMessage(
                        JSON.parse(line) as unknown,
                    );
                } catch {
                    return;
                }
                if (!parsed) return;
                if (parsed.type === "ready") {
                    this.readyMessage = parsed;
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        if (this.cancelStartup === cancelStartup) this.cancelStartup = null;
                        resolve(parsed);
                    }
                }
                for (const listener of this.listeners) {
                    try {
                        listener(parsed);
                    } catch {
                        // Observability must not stop capture or leak raw data.
                    }
                }
                if (parsed.type === "privacy_violation" || parsed.type === "error") {
                    const error = new Error(
                        parsed.type === "privacy_violation"
                            ? "O capturador tentou emitir áudio no modo privado."
                            : "O capturador de calibração informou um erro.",
                    );
                    if (!settled) {
                        failStartup(error);
                    } else {
                        this.markFatal(error, false);
                        child.kill();
                    }
                }
            });
            const processFailed = (): void => {
                if (this.child !== child || this.intentionalStops.has(child)) return;
                const error = new Error(
                    "O processo de captura de calibração falhou.",
                );
                if (!settled) failStartup(error);
                else {
                    this.markFatal(error);
                    child.kill();
                }
            };
            child.once("error", processFailed);
            child.stdin.on("error", processFailed);
            child.once("close", () => {
                const intentional = this.intentionalStops.has(child);
                const stillOwnsProcess = this.child === child;
                if (stillOwnsProcess) {
                    this.child = null;
                    this.readyMessage = null;
                }
                if (!intentional && stillOwnsProcess) {
                    const error = new Error(
                        "O capturador de calibração encerrou inesperadamente.",
                    );
                    if (!settled) failStartup(error);
                    else this.markFatal(error);
                }
            });
            // Drain diagnostics without copying device names, paths or audio
            // metadata into the report/terminal.
            child.stderr.resume();
        });
        this.startupPromise = startupPromise;
        const clearStartup = (): void => {
            if (this.startupPromise === startupPromise) this.startupPromise = null;
        };
        void startupPromise.then(clearStartup, clearStartup);
        return startupPromise;
    }

    pause(): void {
        this.send({ type: "pause" });
    }

    resume(): void {
        this.send({ type: "resume" });
    }

    setPlaybackActive(active: boolean): void {
        this.send({ type: "playback", active });
    }

    startPlaybackReference(reference: PlaybackReference): void {
        this.send({
            type: "playback_reference_start",
            path: reference.path,
            generation: reference.generation,
            startedAtUnixMs: reference.startedAtUnixMs,
        });
    }

    endPlaybackReference(reference: PlaybackReference): void {
        this.send({
            type: "playback_reference_end",
            generation: reference.generation,
        });
    }

    stop(): void {
        this.cancelStartup?.(new DOMException("Calibração cancelada.", "AbortError"));
        this.startupPromise = null;
        const child = this.child;
        if (!child) return;
        this.intentionalStops.add(child);
        try {
            if (!child.killed && child.stdin.writable) {
                child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
            }
        } catch {
            // A broken control pipe must not prevent terminating this child or
            // cleaning up Kokoro in the caller's finally block.
        } finally {
            child.kill();
            this.child = null;
            this.readyMessage = null;
        }
    }

    private send(message: Record<string, unknown>): void {
        if (this.fatalError) throw this.fatalError;
        if (!this.child || this.child.killed || !this.child.stdin.writable) {
            throw new Error("O capturador de calibração não está disponível.");
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private markFatal(error: Error, notify = true): void {
        if (this.fatalError) return;
        this.fatalError = error;
        if (!notify) return;
        for (const listener of this.listeners) {
            try {
                listener({ type: "error" });
            } catch {
                // Fatal state is retained even if an observer fails.
            }
        }
    }
}
