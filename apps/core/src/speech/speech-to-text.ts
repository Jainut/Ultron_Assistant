import {
    spawn,
    type ChildProcessByStdio,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable } from "node:stream";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { runtimeConfig, servicePath } from "../config/runtime.ts";
import { debugLog, serviceError } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";
import type { PlaybackReference } from "./playback-reference.ts";


export type VoiceActivityDetector = "webrtcvad" | "rms";

export interface CaptureEndpointMetrics {
    readonly reason: "silence" | "timeout" | "discarded";
    readonly speechDurationMs: number;
    readonly voicedDurationMs: number;
    readonly endpointDelayMs: number;
    readonly silenceTargetMs: number;
    readonly detector: VoiceActivityDetector;
}

export interface CaptureEchoSuppressionMetrics {
    readonly correlation: number;
    readonly residualRatio: number;
    readonly delayMs: number;
    readonly generation: number;
    readonly processingMs: number;
    readonly queueAgeMs: number;
}

export type CaptureMessage =
    | {
        readonly type: "ready";
        readonly detector?: VoiceActivityDetector;
        readonly endpoint?: {
            readonly minimumMs: number;
            readonly targetMs: number;
            readonly maximumMs: number;
        };
        readonly echoReference?: {
            readonly enabled: boolean;
            readonly maximumDelayMs: number;
            readonly correlationThreshold: number;
            readonly residualRatioThreshold: number;
        };
    }
    | {
        readonly type: "input_device";
        readonly device: number;
        readonly name: string;
        readonly fallback: boolean;
    }
    | {
        readonly type: "speech_start";
        readonly rms?: number;
        readonly playback?: boolean;
        readonly detector?: VoiceActivityDetector;
    }
    | ({ readonly type: "speech_end" } & CaptureEndpointMetrics)
    | ({ readonly type: "echo_suppressed" } & CaptureEchoSuppressionMetrics)
    | {
        readonly type: "audio";
        readonly path: string;
        readonly endpoint?: CaptureEndpointMetrics;
    }
    | {
        readonly type: "error";
        readonly error: string;
    };

export function parseCaptureMessage(value: unknown): CaptureMessage | null {
    if (!isRecord(value) || typeof value.type !== "string") return null;

    switch (value.type) {
        case "ready": {
            const detector = optionalDetector(value.detector);
            const endpoint = isEndpointConfiguration(value.endpoint)
                ? value.endpoint
                : undefined;
            const echoReference = parseEchoReferenceConfiguration(
                value.echoReference,
            );
            return {
                type: "ready",
                ...(detector ? { detector } : {}),
                ...(endpoint ? { endpoint } : {}),
                ...(echoReference ? { echoReference } : {}),
            };
        }
        case "input_device":
            return typeof value.device === "number"
                && typeof value.name === "string"
                && typeof value.fallback === "boolean"
                ? {
                    type: "input_device",
                    device: value.device,
                    name: value.name,
                    fallback: value.fallback,
                }
                : null;
        case "speech_start": {
            const detector = optionalDetector(value.detector);
            return {
                type: "speech_start",
                ...(typeof value.rms === "number" ? { rms: value.rms } : {}),
                ...(typeof value.playback === "boolean"
                    ? { playback: value.playback }
                    : {}),
                ...(detector ? { detector } : {}),
            };
        }
        case "speech_end": {
            const metrics = parseEndpointMetrics(value);
            return metrics ? { type: "speech_end", ...metrics } : null;
        }
        case "echo_suppressed": {
            const metrics = parseEchoSuppressionMetrics(value);
            return metrics ? { type: "echo_suppressed", ...metrics } : null;
        }
        case "audio": {
            if (typeof value.path !== "string" || !value.path) return null;
            const endpoint = parseEndpointMetrics(value.endpoint);
            return {
                type: "audio",
                path: value.path,
                ...(endpoint ? { endpoint } : {}),
            };
        }
        case "error":
            return typeof value.error === "string"
                ? { type: "error", error: value.error }
                : null;
        default:
            return null;
    }
}

function parseEchoReferenceConfiguration(value: unknown): {
    enabled: boolean;
    maximumDelayMs: number;
    correlationThreshold: number;
    residualRatioThreshold: number;
} | undefined {
    if (
        !isRecord(value)
        || typeof value.enabled !== "boolean"
        || !isNonNegativeFinite(value.maximumDelayMs)
        || !isUnitInterval(value.correlationThreshold)
        || !isUnitInterval(value.residualRatioThreshold)
    ) {
        return undefined;
    }
    return {
        enabled: value.enabled,
        maximumDelayMs: value.maximumDelayMs,
        correlationThreshold: value.correlationThreshold,
        residualRatioThreshold: value.residualRatioThreshold,
    };
}

function parseEchoSuppressionMetrics(
    value: unknown,
): CaptureEchoSuppressionMetrics | undefined {
    if (
        !isRecord(value)
        || !isUnitInterval(value.correlation)
        || !isUnitInterval(value.residualRatio)
        || !isNonNegativeFinite(value.delayMs)
        || !isNonNegativeSafeInteger(value.generation)
        || !isNonNegativeFinite(value.processingMs)
        || !isNonNegativeFinite(value.queueAgeMs)
    ) {
        return undefined;
    }
    return {
        correlation: value.correlation,
        residualRatio: value.residualRatio,
        delayMs: value.delayMs,
        generation: value.generation,
        processingMs: value.processingMs,
        queueAgeMs: value.queueAgeMs,
    };
}

function parseEndpointMetrics(value: unknown): CaptureEndpointMetrics | undefined {
    if (!isRecord(value)) return undefined;
    const reason = value.reason;
    const detector = optionalDetector(value.detector);
    if (
        (reason !== "silence" && reason !== "timeout" && reason !== "discarded")
        || !detector
        || !isNonNegativeFinite(value.speechDurationMs)
        || !isNonNegativeFinite(value.voicedDurationMs)
        || !isNonNegativeFinite(value.endpointDelayMs)
        || !isNonNegativeFinite(value.silenceTargetMs)
    ) {
        return undefined;
    }
    return {
        reason,
        detector,
        speechDurationMs: value.speechDurationMs,
        voicedDurationMs: value.voicedDurationMs,
        endpointDelayMs: value.endpointDelayMs,
        silenceTargetMs: value.silenceTargetMs,
    };
}

function optionalDetector(value: unknown): VoiceActivityDetector | undefined {
    return value === "webrtcvad" || value === "rms" ? value : undefined;
}

function isEndpointConfiguration(value: unknown): value is {
    minimumMs: number;
    targetMs: number;
    maximumMs: number;
} {
    return isRecord(value)
        && isNonNegativeFinite(value.minimumMs)
        && isNonNegativeFinite(value.targetMs)
        && isNonNegativeFinite(value.maximumMs);
}

function isNonNegativeFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUnitInterval(value: unknown): value is number {
    return isNonNegativeFinite(value) && value <= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


export class SpeechToTextService {
    private readonly speechStartListeners =
        new Set<() => void>();
    private readonly speechEndListeners =
        new Set<(metrics?: CaptureEndpointMetrics) => void>();
    private readonly transcriptionStartListeners = new Set<() => void>();
    private readonly transcriptionEndListeners = new Set<() => void>();
    private whisperProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
    private captureProcess: ChildProcessWithoutNullStreams | null = null;

    private captureReady = false;

    private pendingResolve: ((text: string) => void) | null = null;
    private pendingReject: ((error: Error) => void) | null = null;
    private readonly recentTranscriptions: string[] = [];
    private speechEndDelivered = false;


    private readonly whisperPort = runtimeConfig.whisperPort;

    private readonly whisperUrl =
        `http://127.0.0.1:${this.whisperPort}/inference`;


    onSpeechStart(
        listener: () => void,
    ): () => void {
        this.speechStartListeners.add(
            listener,
        );

        return () => {
            this.speechStartListeners.delete(
                listener,
            );
        };
    }

    onSpeechEnd(
        listener: (metrics?: CaptureEndpointMetrics) => void,
    ): () => void {
        this.speechEndListeners.add(listener);
        return () => this.speechEndListeners.delete(listener);
    }

    onTranscriptionStart(listener: () => void): () => void {
        this.transcriptionStartListeners.add(listener);
        return () => this.transcriptionStartListeners.delete(listener);
    }

    onTranscriptionEnd(listener: () => void): () => void {
        this.transcriptionEndListeners.add(listener);
        return () => this.transcriptionEndListeners.delete(listener);
    }

    async start(): Promise<void> {
        const whisperDir = servicePath("speech-whisper");

        const whisperExe = path.join(
            whisperDir,
            "build",
            "bin",
            "whisper-server.exe",
        );

        const modelPath = path.join(
            whisperDir,
            runtimeConfig.whisperModel,
        );

        const captureDir = servicePath("speech-input");

        const pythonExe = path.join(
            captureDir,
            ".venv",
            "Scripts",
            "python.exe",
        );

        const captureScript = path.join(
            captureDir,
            "src",
            "capture_service.py",
        );


        const whisperProcess = spawn(
            whisperExe,
            [
                "-m",
                modelPath,

                "--host",
                "127.0.0.1",

                "--port",
                String(this.whisperPort),

                "-l",
                runtimeConfig.whisperLanguage,

                "-t",
                    String(runtimeConfig.whisperThreads),

                "-fa",

                "-nt",

                "--beam-size",
                String(runtimeConfig.whisperBeamSize),

                "--best-of",
                String(runtimeConfig.whisperBestOf),

                "--no-speech-thold",
                String(runtimeConfig.whisperNoSpeechThreshold),

                "--carry-initial-prompt",

                "--prompt",
                runtimeConfig.whisperTerms.join(", "),
            ],
            {
                cwd: whisperDir,
                windowsHide: true,
                stdio: [
                    "ignore",
                    "pipe",
                    "pipe",
                ],
            },
        );

        this.whisperProcess = whisperProcess;


        whisperProcess.on(
            "exit",
            (code) => {
                if (code !== 0) {
                    console.error(
                        `[Whisper] servidor encerrado com código ${code}`
                    );
                }
            },
        );


        await this.waitForWhisper();


        this.captureProcess = spawn(
            pythonExe,
            [
                "-u",
                captureScript,
            ],
            {
                cwd: captureDir,

                env: {
                    ...process.env,

                    PYTHONIOENCODING: "utf-8",
                    PYTHONUTF8: "1",
                    PYTHONUNBUFFERED: "1",
                    ULTRON_ENDPOINT_MIN_MS: String(runtimeConfig.sttEndpointMinMs),
                    ULTRON_ENDPOINT_TARGET_MS: String(runtimeConfig.sttEndpointTargetMs),
                    ULTRON_ENDPOINT_MAX_MS: String(runtimeConfig.sttEndpointMaxMs),
                    ULTRON_MIN_VOICED_SECONDS: String(
                        runtimeConfig.sttMinimumVoicedMs / 1_000,
                    ),
                    ULTRON_VAD_ENABLED: runtimeConfig.sttVadEnabled ? "1" : "0",
                    ULTRON_VAD_MODE: String(runtimeConfig.sttVadMode),
                },

                windowsHide: true,
                stdio: [
                    "pipe",
                    "pipe",
                    "pipe",
                ],
            },
        );


        this.captureProcess.stderr.on(
            "data",
            (data) => {
                const text = data
                    .toString()
                    .trim();

                if (text) {
                    serviceError("[STT]", text);
                }
            },
        );


        let buffer = "";

        this.captureProcess.stdout.on(
            "data",
            (data) => {
                buffer += data.toString();

                const lines = buffer.split(
                    "\n"
                );

                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    const trimmed = line.trim();

                    if (!trimmed) {
                        continue;
                    }

                    try {
                        const message = parseCaptureMessage(
                            JSON.parse(trimmed) as unknown,
                        );

                        if (!message) continue;

                        void this.handleCaptureMessage(
                            message
                        );

                    } catch {
                        // Ignora saída não JSON.
                    }
                }
            },
        );


        await this.waitForCapture();
    }


    private async waitForWhisper(): Promise<void> {
        const deadline =
            Date.now() + 60_000;

        while (Date.now() < deadline) {
            try {
                const response = await fetch(
                    `http://127.0.0.1:${this.whisperPort}/`
                );

                if (response.ok) {
                    return;
                }

            } catch {
                // Ainda carregando o modelo.
            }

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        250,
                    )
            );
        }

        throw new Error(
            "Whisper Server não iniciou dentro do tempo esperado."
        );
    }


    private async waitForCapture(): Promise<void> {
        const deadline =
            Date.now() + 10_000;

        while (Date.now() < deadline) {
            if (this.captureReady) {
                return;
            }

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        50,
                    )
            );
        }

        throw new Error(
            "Serviço de captura de áudio não iniciou."
        );
    }


    private async handleCaptureMessage(
        message: CaptureMessage,
    ): Promise<void> {
        if (
            message.type ===
            "ready"
        ) {
            this.captureReady =
                true;

            debugLog("[STT] Captura pronta:", {
                detector: message.detector ?? "rms",
                endpoint: message.endpoint,
                echoReference: message.echoReference,
            });

            return;
        }

        if (message.type === "input_device") {
            debugLog("[STT] Dispositivo de entrada:", {
                id: message.device,
                name: message.name,
                fallback: message.fallback,
            });
            return;
        }

        if (
            message.type ===
            "speech_start"
        ) {
            this.speechEndDelivered = false;
            debugLog(
                "[BARGE] speech_start recebido do Python."
            );

            for (
                const listener
                of this.speechStartListeners
            ) {
                listener();
            }

            return;
        }

        if (message.type === "speech_end") {
            this.emitSpeechEnd(message);
            return;
        }

        if (message.type === "echo_suppressed") {
            perf.record("Echo filter", message.processingMs);
            debugLog("[BARGE][ECHO] Referência do playback suprimida:", {
                correlation: message.correlation,
                residualRatio: message.residualRatio,
                delayMs: message.delayMs,
                generation: message.generation,
                processingMs: message.processingMs,
                queueAgeMs: message.queueAgeMs,
            });
            return;
        }

        if (
            message.type ===
            "error"
        ) {
            const error =
                new Error(
                    message.error
                    ?? "Erro desconhecido na captura."
                );

            this.pendingReject?.(
                error
            );

            this.clearPending();

            return;
        }

        if (
            message.type ===
            "audio"
            && message.path
        ) {
            if (!this.speechEndDelivered) {
                this.emitSpeechEnd(message.endpoint);
            }
            for (const listener of this.transcriptionStartListeners) listener();

            try {
                const text =
                    await this.transcribe(
                        message.path
                    );


                if (!text) {
                    this.sendCapture({
                        type: "resume",
                    });

                    return;
                }


                this.pendingResolve?.(
                    text
                );

                this.clearPending();

            } catch (error) {
                const normalizedError =
                    error instanceof Error
                        ? error
                        : new Error(
                            String(error)
                        );


                this.pendingReject?.(
                    normalizedError
                );


                this.clearPending();
            } finally {
                for (const listener of this.transcriptionEndListeners) listener();
            }
        }
    }


    private async transcribe(
        audioPath: string
    ): Promise<string> {
        try {
            const audio = await readFile(
                audioPath
            );

            const form = new FormData();

            form.append(
                "file",
                new Blob(
                    [audio],
                    {
                        type: "audio/wav",
                    },
                ),
                path.basename(
                    audioPath
                ),
            );

            form.append(
                "language",
                runtimeConfig.whisperLanguage
            );

            form.append(
                "temperature",
                String(runtimeConfig.whisperTemperature)
            );

            form.append("temperature_inc", "0.2");
            form.append("beam_size", String(runtimeConfig.whisperBeamSize));
            form.append("best_of", String(runtimeConfig.whisperBestOf));
            form.append("no_speech_thold", String(runtimeConfig.whisperNoSpeechThreshold));

            form.append(
                "response_format",
                "text"
            );

            form.append(
                "no_timestamps",
                "true"
            );

            form.append(
                "suppress_non_speech",
                "true"
            );

            form.append(
                "prompt",
                [
                    ...runtimeConfig.whisperTerms,
                    ...this.recentTranscriptions.slice(-2),
                ].join(", "),
            );

            form.append("carry_initial_prompt", "true");


            const response = await perf.measure(
                "STT transcription",
                () => fetch(
                    this.whisperUrl,
                    {
                        method: "POST",
                        body: form,
                    },
                ),
            );


            if (!response.ok) {
                const body =
                    await response.text();

                throw new Error(
                    `Whisper respondeu ${response.status}: ${body}`
                );
            }


            const text =
                await response.text();
            const transcription = text.trim();

            if (transcription) {
                this.recentTranscriptions.push(transcription);
                if (this.recentTranscriptions.length > 4) this.recentTranscriptions.shift();
                debugLog(`[STT] "${transcription}"`);
            }

            return transcription;

        } finally {
            await unlink(
                audioPath
            ).catch(
                () => undefined
            );
        }
    }


    listen(): Promise<string> {
        if (!this.captureProcess) {
            return Promise.reject(
                new Error(
                    "Serviço STT não iniciado."
                )
            );
        }


        if (this.pendingResolve) {
            return Promise.reject(
                new Error(
                    "Já existe uma escuta STT pendente."
                )
            );
        }


        return new Promise<string>(
            (resolve, reject) => {
                this.pendingResolve =
                    resolve;

                this.pendingReject =
                    reject;

                this.sendCapture({
                    type: "resume",
                });
            },
        );
    }


    pause(): void {
        this.sendCapture({
            type: "pause",
        });
    }


    resume(): void {
        this.sendCapture({
            type: "resume",
        });
    }

    setPlaybackActive(active: boolean): void {
        this.sendCapture({
            type: "playback",
            active,
        });
    }

    startPlaybackReference(reference: PlaybackReference): void {
        this.sendCapture({
            type: "playback_reference_start",
            path: reference.path,
            generation: reference.generation,
            startedAtUnixMs: reference.startedAtUnixMs,
        });
    }

    endPlaybackReference(reference: PlaybackReference): void {
        this.sendCapture({
            type: "playback_reference_end",
            path: reference.path,
            generation: reference.generation,
            startedAtUnixMs: reference.startedAtUnixMs,
        });
    }


    private sendCapture(
        message: object
    ): void {
        if (
            !this.captureProcess
            || this.captureProcess.killed
        ) {
            return;
        }

        this.captureProcess.stdin.write(
            JSON.stringify(
                message
            ) + "\n"
        );
    }


    private emitSpeechEnd(metrics?: CaptureEndpointMetrics): void {
        if (this.speechEndDelivered) return;
        this.speechEndDelivered = true;

        if (metrics) {
            perf.record("STT endpoint delay", metrics.endpointDelayMs);
            debugLog("[STT] Endpoint:", {
                reason: metrics.reason,
                delayMs: metrics.endpointDelayMs,
                targetMs: metrics.silenceTargetMs,
                voicedMs: metrics.voicedDurationMs,
                detector: metrics.detector,
            });
        }

        for (const listener of this.speechEndListeners) listener(metrics);
    }


    private clearPending(): void {
        this.pendingResolve = null;
        this.pendingReject = null;
    }


    stop(): void {
        this.sendCapture({
            type: "stop",
        });

        this.captureProcess?.kill();
        this.whisperProcess?.kill();

        this.captureProcess = null;
        this.whisperProcess = null;

        this.captureReady = false;
        this.speechEndDelivered = false;

        this.clearPending();
    }
}
