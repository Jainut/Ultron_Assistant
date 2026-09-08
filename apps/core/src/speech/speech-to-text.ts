import {
    spawn,
    type ChildProcessByStdio,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable } from "node:stream";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeConfig, servicePath } from "../config/runtime.ts";
import {
    awaitServiceOperation,
    serviceError as normalizeServiceError,
    timedServiceOperation,
} from "../system/service-lifecycle.ts";
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


export interface SpeechToTextServiceOptions {
    /** Lifecycle tests inject subprocesses and HTTP; no microphone/model is needed. */
    spawnService?: typeof spawn;
    fetch?: typeof fetch;
    startupTimeoutMs?: number;
    whisperStartupTimeoutMs?: number;
    captureStartupTimeoutMs?: number;
    transcriptionTimeoutMs?: number;
    healthTimeoutMs?: number;
    pollIntervalMs?: number;
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
    private ready = false;
    private generation = 0;
    private lifecycle: AbortController | null = null;
    private startupPromise: Promise<void> | null = null;
    private captureReadyResolver: (() => void) | null = null;
    private readonly failureListeners = new Set<(error: Error) => void>();
    private sessionFailed = false;
    // Playback belongs to the conversation, not the capture-process generation.
    // Remember controls received while the microphone is starting/recovering.
    private playbackActive: boolean | null = null;
    private playbackReference: PlaybackReference | null = null;

    private pendingResolve: ((text: string) => void) | null = null;
    private pendingReject: ((error: Error) => void) | null = null;
    private listenId = 0;
    private listenController: AbortController | null = null;
    private removeListenAbort: (() => void) | null = null;
    private activeTranscription: { generation: number; listenId: number; path: string } | null = null;
    private readonly recentTranscriptions: string[] = [];
    private speechEndDelivered = false;


    private readonly whisperPort = runtimeConfig.whisperPort;

    private readonly whisperUrl =
        `http://127.0.0.1:${this.whisperPort}/inference`;

    constructor(private readonly options: SpeechToTextServiceOptions = {}) {}

    isReady(): boolean {
        return this.ready && this.captureReady
            && Boolean(this.whisperProcess && !this.whisperProcess.killed)
            && Boolean(this.captureProcess && !this.captureProcess.killed);
    }

    onFailure(listener: (error: Error) => void): () => void {
        this.failureListeners.add(listener);
        return () => this.failureListeners.delete(listener);
    }

    async healthCheck(signal?: AbortSignal): Promise<boolean> {
        signal?.throwIfAborted();
        if (!this.isReady()) return false;
        // whisper-server may serialize GET behind inference. A live request is
        // bounded separately; do not restart a healthy model during decoding.
        if (this.activeTranscription) return true;
        try {
            return await this.probeWhisper(signal) && this.isReady();
        } catch {
            signal?.throwIfAborted();
            return false;
        }
    }


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

    start(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (this.isReady()) return Promise.resolve();
        if (this.startupPromise) return signal
            ? awaitServiceOperation(this.startupPromise, signal) : this.startupPromise;

        const generation = ++this.generation;
        const lifecycle = new AbortController();
        this.lifecycle = lifecycle;
        this.sessionFailed = false;
        const abort = (): void => lifecycle.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        const task = timedServiceOperation(innerSignal => this.launch(innerSignal, generation), {
            signal: lifecycle.signal,
            timeoutMs: this.options.startupTimeoutMs ?? 90_000,
            label: "STT startup",
        }).then(() => {
            lifecycle.signal.throwIfAborted();
            if (generation !== this.generation) throw new DOMException("STT reiniciado.", "AbortError");
            this.ready = true;
        }).catch(error => {
            if (generation === this.generation) {
                if (signal?.aborted) {
                    this.terminateProcesses();
                } else this.failSession(normalizeServiceError(error), generation);
            }
            throw error;
        }).finally(() => {
            signal?.removeEventListener("abort", abort);
            if (this.startupPromise === task) this.startupPromise = null;
        });
        this.startupPromise = task;
        // Listening/startup may be awaited only after a current TTS chunk ends.
        // Observe rejections now without changing what the original promise returns.
        void task.catch(() => undefined);
        return task;
    }

    private async launch(signal: AbortSignal, generation: number): Promise<void> {
        signal.throwIfAborted();
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


        const whisperProcess = (this.options.spawnService ?? spawn)(
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


        const whisperFailure = (error: Error): void => {
            if (this.whisperProcess === whisperProcess) this.failSession(error, generation);
        };
        whisperProcess.once("error", whisperFailure);
        whisperProcess.once("exit", code => whisperFailure(new Error(
            `Whisper encerrou com código ${code}.`,
        )));
        whisperProcess.once("close", code => whisperFailure(new Error(
            `Whisper encerrou com código ${code}.`,
        )));
        // Both pipes must be drained: a full stderr pipe otherwise stalls decoding.
        whisperProcess.stdout.resume();
        whisperProcess.stdout.on("error", whisperFailure);
        whisperProcess.stderr.on("error", whisperFailure);
        whisperProcess.stderr.on("data", (data: Buffer) => {
            if (this.whisperProcess === whisperProcess) serviceError("[Whisper]", data.toString());
        });

        await this.waitForWhisper(signal);
        signal.throwIfAborted();
        if (generation !== this.generation) throw new DOMException("STT reiniciado.", "AbortError");

        const captureProcess = (this.options.spawnService ?? spawn)(
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


        this.captureProcess = captureProcess;
        const captureFailure = (error: Error): void => {
            if (this.captureProcess === captureProcess) this.failSession(error, generation);
        };
        captureProcess.once("error", captureFailure);
        captureProcess.once("exit", code => captureFailure(new Error(
            `Captura de áudio encerrou com código ${code}.`,
        )));
        captureProcess.once("close", code => captureFailure(new Error(
            `Captura de áudio encerrou com código ${code}.`,
        )));
        captureProcess.stdin.on("error", captureFailure);
        captureProcess.stdout.on("error", captureFailure);
        captureProcess.stderr.on("error", captureFailure);

        captureProcess.stderr.on(
            "data",
            (data) => {
                if (this.captureProcess !== captureProcess) return;
                const text = data
                    .toString()
                    .trim();

                if (text) {
                    serviceError("[STT]", text);
                }
            },
        );


        let buffer = "";

        captureProcess.stdout.on(
            "data",
            (data) => {
                if (this.captureProcess !== captureProcess || generation !== this.generation) return;
                buffer += data.toString();
                if (buffer.length > 1_048_576) {
                    captureFailure(new Error("A captura excedeu o limite do protocolo JSON."));
                    return;
                }

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
                            message, generation,
                        ).catch(error => captureFailure(normalizeServiceError(error)));

                    } catch {
                        // Ignora saída não JSON.
                    }
                }
            },
        );


        await this.waitForCapture(signal, generation);
    }


    private async probeWhisper(signal?: AbortSignal): Promise<boolean> {
        return timedServiceOperation(async requestSignal => {
            const response = await (this.options.fetch ?? fetch)(
                `http://127.0.0.1:${this.whisperPort}/`, { signal: requestSignal },
            );
            void response.body?.cancel().catch(() => undefined);
            requestSignal.throwIfAborted();
            return response.ok;
        }, { signal, timeoutMs: this.options.healthTimeoutMs ?? 1_500, label: "Whisper health" });
    }

    private async waitForWhisper(signal: AbortSignal): Promise<void> {
        await timedServiceOperation(async startupSignal => {
            while (true) {
                startupSignal.throwIfAborted();
                try {
                    if (await this.probeWhisper(startupSignal)) return;
                } catch {
                    startupSignal.throwIfAborted();
                    // Ainda carregando o modelo; a tentativa HTTP também é limitada.
                }
                await delay(this.options.pollIntervalMs ?? 250, undefined, { signal: startupSignal });
            }
        }, { signal, timeoutMs: this.options.whisperStartupTimeoutMs ?? 60_000, label: "Whisper startup" });
    }

    private async waitForCapture(signal: AbortSignal, generation: number): Promise<void> {
        if (this.captureReady) return;
        try {
            await timedServiceOperation(() => new Promise<void>(resolve => {
                this.captureReadyResolver = resolve;
                if (this.captureReady) resolve();
            }), { signal, timeoutMs: this.options.captureStartupTimeoutMs ?? 10_000, label: "Captura startup" });
        } finally {
            if (generation === this.generation) this.captureReadyResolver = null;
        }
    }


    private async handleCaptureMessage(
        message: CaptureMessage,
        generation: number,
    ): Promise<void> {
        if (generation !== this.generation || this.sessionFailed || !this.captureProcess) return;
        if (
            message.type ===
            "ready"
        ) {
            this.captureReady =
                true;
            if (!this.restorePlaybackState()) {
                this.failSession(new Error("A captura não recebeu o estado acústico de playback."), generation);
                return;
            }
            this.captureReadyResolver?.();

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
                try { listener(); } catch { /* Observer isolation. */ }
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

            this.failSession(error, generation);

            return;
        }

        if (
            message.type ===
            "audio"
            && message.path
        ) {
            const listenId = this.listenId;
            const listenController = this.listenController;
            if (!listenController || !this.pendingResolve) {
                if (this.activeTranscription?.path !== message.path) {
                    await unlink(message.path).catch(() => undefined);
                }
                return;
            }
            // One WAV belongs to one listen. Late/duplicate capture events must
            // not transcribe twice or resolve a newer utterance after cancellation.
            if (this.activeTranscription?.listenId === listenId
                && this.activeTranscription.generation === generation) {
                if (this.activeTranscription.path !== message.path) {
                    await unlink(message.path).catch(() => undefined);
                }
                return;
            }
            const active = { generation, listenId, path: message.path };
            this.activeTranscription = active;
            const ownsListen = (): boolean => generation === this.generation
                && listenId === this.listenId && this.listenController === listenController
                && !listenController.signal.aborted;
            if (!this.speechEndDelivered) {
                this.emitSpeechEnd(message.endpoint);
            }
            for (const listener of this.transcriptionStartListeners) {
                try { listener(); } catch { /* Observer isolation. */ }
            }

            try {
                const text =
                    await this.transcribe(
                        message.path, listenController.signal,
                    );
                if (!ownsListen()) return;

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
                if (!ownsListen()) return;
                const normalizedError = normalizeServiceError(error);
                if ("code" in normalizedError && normalizedError.code === "ETIMEDOUT") {
                    // HTTP cancellation alone does not guarantee that Whisper
                    // stopped a stalled decode. Retire this owned session before
                    // the supervisor can attempt a bounded fresh start.
                    this.failSession(normalizedError, generation);
                    return;
                }
                this.pendingReject?.(normalizedError);
                this.clearPending();
            } finally {
                if (this.activeTranscription === active) {
                    this.activeTranscription = null;
                    for (const listener of this.transcriptionEndListeners) {
                        try { listener(); } catch { /* Observer isolation. */ }
                    }
                }
            }
        }
    }


    private async transcribe(
        audioPath: string,
        signal: AbortSignal,
    ): Promise<string> {
        try {
            return await timedServiceOperation(async requestSignal => {
            const audio = await readFile(
                audioPath, { signal: requestSignal },
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
                () => (this.options.fetch ?? fetch)(
                    this.whisperUrl,
                    {
                        method: "POST",
                        body: form,
                        signal: requestSignal,
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
            requestSignal.throwIfAborted();
            const transcription = text.trim();

            if (transcription) {
                this.recentTranscriptions.push(transcription);
                if (this.recentTranscriptions.length > 4) this.recentTranscriptions.shift();
                debugLog(`[STT] "${transcription}"`);
            }

            return transcription;
            }, { signal, timeoutMs: this.options.transcriptionTimeoutMs ?? 60_000, label: "STT transcription" });
        } finally {
            await unlink(
                audioPath
            ).catch(
                () => undefined
            );
        }
    }


    listen(signal?: AbortSignal): Promise<string> {
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (!this.isReady()) {
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


        const listenController = new AbortController();
        this.listenController = listenController;
        const listenId = ++this.listenId;
        const task = new Promise<string>(
            (resolve, reject) => {
                this.pendingResolve =
                    resolve;

                this.pendingReject =
                    reject;

                const abort = (): void => {
                    if (this.listenId !== listenId || this.listenController !== listenController) return;
                    this.rejectPending(normalizeServiceError(signal?.reason
                        ?? new DOMException("Escuta cancelada.", "AbortError")));
                    this.pause();
                };
                signal?.addEventListener("abort", abort, { once: true });
                this.removeListenAbort = () => signal?.removeEventListener("abort", abort);
                if (signal?.aborted) {
                    abort();
                    return;
                }
                if (!this.sendCapture({
                    type: "resume",
                })) this.rejectPending(new Error("Captura de áudio indisponível."));
            },
        );
        void task.catch(() => undefined);
        return task;
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
        this.playbackActive = active;
        if (!active) this.playbackReference = null;
        this.sendCapture({
            type: "playback",
            active,
        });
    }

    startPlaybackReference(reference: PlaybackReference): void {
        this.playbackReference = { ...reference };
        this.sendCapture({
            type: "playback_reference_start",
            path: reference.path,
            generation: reference.generation,
            startedAtUnixMs: reference.startedAtUnixMs,
        });
    }

    endPlaybackReference(reference: PlaybackReference): void {
        const current = this.playbackReference;
        if (current?.path === reference.path && current.generation === reference.generation
            && current.startedAtUnixMs === reference.startedAtUnixMs) {
            this.playbackReference = null;
        }
        this.sendCapture({
            type: "playback_reference_end",
            path: reference.path,
            generation: reference.generation,
            startedAtUnixMs: reference.startedAtUnixMs,
        });
    }

    private restorePlaybackState(): boolean {
        // This runs inside the ready handler, before the startup promise can
        // resolve and any consumer can resume listening. Replaying only the
        // current snapshot cannot resurrect a reference ended while offline.
        if (this.playbackActive !== null
            && !this.sendCapture({ type: "playback", active: this.playbackActive })) return false;
        const reference = this.playbackReference;
        return !reference || this.sendCapture({
            type: "playback_reference_start",
            path: reference.path,
            generation: reference.generation,
            startedAtUnixMs: reference.startedAtUnixMs,
        });
    }


    private sendCapture(
        message: object
    ): boolean {
        if (
            !this.captureProcess
            || this.captureProcess.killed
            || this.captureProcess.stdin.writable === false
        ) {
            return false;
        }

        try {
            this.captureProcess.stdin.write(JSON.stringify(message) + "\n");
            return true;
        } catch (error) {
            this.failSession(normalizeServiceError(error), this.generation);
            return false;
        }
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

        for (const listener of this.speechEndListeners) {
            try { listener(metrics); } catch { /* Observer isolation. */ }
        }
    }


    private clearPending(): void {
        this.removeListenAbort?.();
        this.removeListenAbort = null;
        this.listenController = null;
        this.pendingResolve = null;
        this.pendingReject = null;
    }

    private rejectPending(error: Error): void {
        this.listenController?.abort(error);
        this.pendingReject?.(error);
        this.clearPending();
    }

    private failSession(error: Error, generation: number): void {
        if (generation !== this.generation || this.sessionFailed) return;
        this.sessionFailed = true;
        this.lifecycle?.abort(error);
        this.rejectPending(error);
        this.terminateProcesses();
        for (const listener of this.failureListeners) {
            try { listener(error); } catch { /* Observer isolation. */ }
        }
    }

    private terminateProcesses(): void {
        const capture = this.captureProcess;
        const whisper = this.whisperProcess;
        // Release ownership before kill: close/EPIPE from an old generation must
        // never clear a replacement process or reject its pending listen.
        this.captureProcess = null;
        this.whisperProcess = null;
        this.ready = false;
        this.captureReady = false;
        this.captureReadyResolver = null;
        this.activeTranscription = null;
        this.speechEndDelivered = false;
        try {
            if (capture && !capture.killed && capture.stdin.writable !== false) {
                capture.stdin.write(`${JSON.stringify({ type: "stop" })}\n`);
            }
        } catch { /* Best effort before terminating our own child. */ }
        try { capture?.kill(); } catch { /* Process may have already exited. */ }
        try { whisper?.kill(); } catch { /* Process may have already exited. */ }
    }

    stop(): void {
        ++this.generation;
        const error = new DOMException("Serviço STT encerrado.", "AbortError");
        this.lifecycle?.abort(error);
        this.lifecycle = null;
        this.rejectPending(error);
        this.terminateProcesses();
        this.startupPromise = null;
    }
}
