import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { servicePath } from "../config/runtime.ts";
import { serviceError } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";
import {
    playAudio as playAudioFallback,
    stopAudio as stopAudioFallback,
} from "./audio_player.ts";

interface PendingRequest {
    resolve: (audioPath: string) => void;
    reject: (error: Error) => void;
    startedAt: number;
    removeAbortListener?: () => void;
}

interface ServiceMessage {
    id?: string;
    type:
        | "ready"
        | "audio_ready"
        | "playback_started"
        | "playback_finished"
        | "playback_cancelled"
        | "playback_flushed"
        | "error";
    path?: string;
    error?: string;
    capabilities?: unknown;
    startup?: unknown;
}

const ttsStartupMetricDefinitions = [
    ["stdlibImportsMs", "TTS Python imports"],
    ["playerImportMs", "TTS player import"],
    ["voiceEngineImportMs", "TTS voice module"],
    ["voiceDependenciesMs", "TTS dependencies"],
    ["pipelineInitializationMs", "TTS pipeline init"],
    ["kokoroWarmUpMs", "TTS Kokoro warm-up"],
    ["effectsWarmUpMs", "TTS effects warm-up"],
    ["warmUpTotalMs", "TTS warm-up total"],
    ["playerInitializationMs", "TTS player init"],
    ["workerInitializationMs", "TTS worker init"],
    ["serviceReadyMs", "TTS Python ready"],
] as const;

type TtsStartupMetricName = typeof ttsStartupMetricDefinitions[number][0];
export type TtsStartupMetrics = Readonly<Partial<
    Record<TtsStartupMetricName, number>
>>;

/** Sanitizes optional telemetry while preserving compatibility with old services. */
export function parseTtsStartupMetrics(value: unknown): TtsStartupMetrics | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    const source = value as Record<string, unknown>;
    const parsed: Partial<Record<TtsStartupMetricName, number>> = {};

    for (const [name] of ttsStartupMetricDefinitions) {
        const elapsed = source[name];
        if (
            typeof elapsed === "number"
            && Number.isFinite(elapsed)
            && elapsed >= 0
        ) {
            parsed[name] = elapsed;
        }
    }

    return Object.keys(parsed).length > 0 ? parsed : null;
}

export function supportsPersistentPlayback(capabilities: unknown): boolean {
    return Array.isArray(capabilities)
        && capabilities.some(capability => capability === "playback-v1");
}

export interface PlaybackCallbacks {
    onStarted?: () => void;
    onFinished?: () => void;
    onCancelled?: () => void;
}

export interface PlaybackOptions extends PlaybackCallbacks {
    signal?: AbortSignal;
}

export interface TextToSpeechServiceOptions {
    /** Allows lifecycle tests without loading Kokoro or opening an audio device. */
    spawnService?: typeof spawn;
    startupTimeoutMs?: number;
    /** Diagnostics need player-confirmed timestamps, not the legacy estimate. */
    requirePersistentPlayback?: boolean;
}

interface PendingPlayback extends PlaybackCallbacks {
    resolve: () => void;
    reject: (error: unknown) => void;
    removeAbortListener?: () => void;
    abortReason?: unknown;
    started: boolean;
}

const ttsRoot = servicePath("tts-kokoro");

const pythonExecutable = path.join(
    ttsRoot,
    ".venv",
    "Scripts",
    "python.exe",
);

const ttsServiceScript = path.join(
    ttsRoot,
    "src",
    "tts_service.py",
);

const outputDirectory = path.join(
    ttsRoot,
    "output",
);

export class TextToSpeechService {
    private child: ChildProcessWithoutNullStreams | null = null;
    private startupPromise: Promise<void> | null = null;
    private rejectStartup: ((error: Error) => void) | null = null;

    private ready = false;
    private persistentPlaybackAvailable = false;

    private readonly pending = new Map<
        string,
        PendingRequest
    >();

    private readonly pendingPlayback = new Map<string, PendingPlayback>();

    constructor(private readonly options: TextToSpeechServiceOptions = {}) {}

    start(): Promise<void> {
        if (this.child && this.ready) {
            return Promise.resolve();
        }

        if (this.startupPromise) {
            return this.startupPromise;
        }

        const startupPromise = new Promise<void>((resolve, reject) => {
            let startupSettled = false;
            let startupTimeout: NodeJS.Timeout | undefined;

            const clearStartup = (): void => {
                if (startupTimeout) clearTimeout(startupTimeout);
                if (this.rejectStartup === rejectStartup) this.rejectStartup = null;
            };

            const resolveStartup = (): void => {
                if (startupSettled) return;
                startupSettled = true;
                clearStartup();
                resolve();
            };

            const rejectStartup = (error: Error): void => {
                if (startupSettled) return;
                startupSettled = true;
                clearStartup();
                reject(error);
            };
            this.rejectStartup = rejectStartup;

            const child = (this.options.spawnService ?? spawn)(
                pythonExecutable,
                [
                    "-u",
                    ttsServiceScript,
                ],
                {
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    env: {
                        ...process.env,
                        PYTHONIOENCODING: "utf-8",
                        PYTHONUTF8: "1",
                        PYTHONUNBUFFERED: "1",

                        HF_HUB_VERBOSITY: "error",
                        PYTHONWARNINGS: "ignore::UserWarning,ignore::FutureWarning",
                    },
                },
            );
            this.child = child;

            const lines = createInterface({
                input: child.stdout,
            });

            lines.on("line", (line) => {
                if (this.child !== child) return;
                this.handleMessage(line, () => {
                    resolveStartup();
                }, handleProcessError);
            });

            child.stderr.on("data", (chunk: Buffer) => {
                serviceError("[Kokoro]", chunk.toString());
            });

            const handleProcessError = (error: Error): void => {
                if (this.child === child) {
                    this.ready = false;
                    this.persistentPlaybackAvailable = false;
                    this.child = null;

                    for (const request of this.pending.values()) {
                        request.removeAbortListener?.();
                        request.reject(error);
                    }
                    this.pending.clear();

                    for (const playback of this.pendingPlayback.values()) {
                        playback.removeAbortListener?.();
                        playback.reject(error);
                    }
                    this.pendingPlayback.clear();
                    child.kill();
                }
                rejectStartup(error);
            };
            child.once("error", handleProcessError);
            // EPIPE can arrive on stdin without a child-process error/close.
            child.stdin.on("error", handleProcessError);

            const configuredTimeout = this.options.startupTimeoutMs ?? 180_000;
            const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
                ? configuredTimeout : 180_000;
            startupTimeout = setTimeout(() => handleProcessError(new Error(
                "O serviço Kokoro excedeu o tempo limite de inicialização.",
            )), timeoutMs);

            child.once("close", (code) => {
                const ownsCurrentProcess = this.child === child;
                if (ownsCurrentProcess) {
                    this.ready = false;
                    this.persistentPlaybackAvailable = false;
                    this.child = null;
                }

                const error = new Error(
                    `O serviço Kokoro encerrou com código ${code}.`,
                );

                if (!startupSettled) {
                    rejectStartup(error);
                }

                if (ownsCurrentProcess) {
                    for (const request of this.pending.values()) {
                        request.removeAbortListener?.();
                        request.reject(error);
                    }

                    this.pending.clear();

                    for (const playback of this.pendingPlayback.values()) {
                        playback.removeAbortListener?.();
                        playback.reject(error);
                    }
                    this.pendingPlayback.clear();
                }
            });
        });

        this.startupPromise = startupPromise;
        const clearStartupPromise = (): void => {
            if (this.startupPromise === startupPromise) {
                this.startupPromise = null;
            }
        };
        void startupPromise.then(clearStartupPromise, clearStartupPromise);
        return startupPromise;
    }

    private handleMessage(
        line: string,
        resolveStart: () => void,
        rejectService?: (error: Error) => void,
    ): void {
        let message: ServiceMessage;

        try {
            message = JSON.parse(line) as ServiceMessage;
        } catch {
            return;
        }

        if (!message || typeof message !== "object") return;
        if (message.type === "error" && !message.id) {
            rejectService?.(new Error(
                message.error ?? "O serviço Kokoro informou um erro fatal.",
            ));
            return;
        }

        if (message.type === "ready") {
            this.ready = true;
            this.persistentPlaybackAvailable = supportsPersistentPlayback(
                message.capabilities,
            );
            const startupMetrics = parseTtsStartupMetrics(message.startup);
            if (startupMetrics) {
                for (const [name, label] of ttsStartupMetricDefinitions) {
                    const elapsed = startupMetrics[name];
                    if (elapsed !== undefined) perf.record(label, elapsed);
                }
            }
            resolveStart();
            return;
        }

        if (!message.id) {
            return;
        }

        const playback = this.pendingPlayback.get(message.id);
        if (playback !== undefined) {
            this.handlePlaybackMessage(message.id, message, playback);
            return;
        }

        const request = this.pending.get(message.id);
        if (!request) return;

        this.pending.delete(message.id);
        request.removeAbortListener?.();

        const elapsed =
            (performance.now() - request.startedAt) / 1000;


        if (message.type === "audio_ready" && message.path) {
            request.resolve(message.path);
            return;
        }

        request.reject(
            new Error(
                message.error ??
                "O serviço não conseguiu gerar a fala.",
            ),
        );
    }

    private handlePlaybackMessage(
        id: string,
        message: ServiceMessage,
        playback: PendingPlayback,
    ): void {
        if (message.type === "playback_started") {
            playback.started = true;
            playback.onStarted?.();
            return;
        }

        if (
            message.type !== "playback_finished"
            && message.type !== "playback_cancelled"
            && message.type !== "error"
        ) {
            return;
        }

        this.pendingPlayback.delete(id);
        playback.removeAbortListener?.();

        if (message.type === "error") {
            playback.reject(new Error(
                message.error ?? "O player persistente não conseguiu reproduzir o áudio.",
            ));
            return;
        }

        if (message.type === "playback_cancelled") {
            playback.onCancelled?.();
            if (playback.abortReason !== undefined) {
                playback.reject(playback.abortReason);
            } else {
                playback.resolve();
            }
            return;
        }

        if (playback.abortReason !== undefined) {
            playback.onCancelled?.();
            playback.reject(playback.abortReason);
            return;
        }

        playback.onFinished?.();
        playback.resolve();
    }

    async synthesize(text: string, signal?: AbortSignal): Promise<string> {
        if (!text.trim()) {
            throw new Error("O texto da fala está vazio.");
        }

        if (!this.child || !this.ready) {
            throw new Error(
                "O serviço de voz ainda não está pronto.",
            );
        }

        const id = randomUUID();

        const audioPath = path.join(
            outputDirectory,
            `speech-${id}.wav`,
        );

        signal?.throwIfAborted();

        return new Promise((resolve, reject) => {
            const abort = (): void => {
                const request = this.pending.get(id);

                if (!request) {
                    return;
                }

                this.pending.delete(id);
                this.child?.stdin.write(`${JSON.stringify({
                    id,
                    type: "cancel",
                })}\n`);
                reject(new DOMException("Síntese cancelada.", "AbortError"));
            };
            const removeAbortListener = signal
                ? (): void => signal.removeEventListener("abort", abort)
                : undefined;

            this.pending.set(id, {
                resolve,
                reject,
                startedAt: performance.now(),
                removeAbortListener,
            });

            signal?.addEventListener("abort", abort, { once: true });

            const message = {
                id,
                type: "speak",
                text,
                output: audioPath,
            };

            this.child?.stdin.write(
                `${JSON.stringify(message)}\n`,
            );
        });
    }

    /**
     * Reproduz no mesmo processo Python do Kokoro quando playback-v1 está
     * disponível. Serviços antigos e plataformas não suportadas preservam o
     * SoundPlayer legado automaticamente.
     */
    async play(audioPath: string, options: PlaybackOptions = {}): Promise<void> {
        if (!audioPath.trim()) {
            throw new Error("O caminho do áudio está vazio.");
        }
        options.signal?.throwIfAborted();

        if (!this.child || !this.ready || !this.persistentPlaybackAvailable) {
            if (this.options.requirePersistentPlayback) {
                throw new Error("O player persistente não está disponível para esta calibração.");
            }
            await this.playWithFallback(audioPath, options);
            return;
        }

        const id = randomUUID();
        let playbackState: PendingPlayback | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                const abort = (): void => {
                    const playback = this.pendingPlayback.get(id);
                    if (playback === undefined) return;
                    if (playback.abortReason !== undefined) return;
                    playback.abortReason = options.signal?.reason
                        ?? new DOMException("Playback cancelado.", "AbortError");
                    this.writeMessage({ id, type: "cancel_playback" });
                };
                const removeAbortListener = options.signal
                    ? (): void => options.signal?.removeEventListener("abort", abort)
                    : undefined;

                playbackState = {
                    resolve,
                    reject,
                    removeAbortListener,
                    onStarted: options.onStarted,
                    onFinished: options.onFinished,
                    onCancelled: options.onCancelled,
                    started: false,
                };
                this.pendingPlayback.set(id, playbackState);

                try {
                    this.writeMessage({ id, type: "play", path: audioPath });
                    options.signal?.addEventListener("abort", abort, { once: true });
                    if (options.signal?.aborted) abort();
                } catch (error) {
                    this.pendingPlayback.delete(id);
                    removeAbortListener?.();
                    reject(error);
                }
            });
        } catch (error) {
            // Se o backend recusou antes de playback_started, ainda é seguro
            // tentar o SoundPlayer legado sem duplicar áudio já iniciado.
            if (
                playbackState !== undefined
                && !playbackState.started
                && playbackState.abortReason === undefined
                && !this.options.requirePersistentPlayback
            ) {
                await this.playWithFallback(audioPath, options);
                return;
            }
            throw error;
        }
    }

    /** Cancela o áudio atual e qualquer item já enfileirado no player Python. */
    stopPlayback(): void {
        if (!this.persistentPlaybackAvailable || !this.child) {
            stopAudioFallback();
            return;
        }

        try {
            this.writeMessage({
                id: randomUUID(),
                type: "flush_playback",
            });
        } catch (error) {
            for (const [id, playback] of this.pendingPlayback) {
                this.pendingPlayback.delete(id);
                playback.removeAbortListener?.();
                playback.reject(error);
            }
        }
    }

    isPersistentPlaybackAvailable(): boolean {
        return this.persistentPlaybackAvailable;
    }

    private async playWithFallback(
        audioPath: string,
        options: PlaybackOptions,
    ): Promise<void> {
        let aborted = false;
        const abort = (): void => {
            aborted = true;
            stopAudioFallback();
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        try {
            options.onStarted?.();
            await playAudioFallback(audioPath);
            if (aborted) {
                options.onCancelled?.();
                throw options.signal?.reason
                    ?? new DOMException("Playback cancelado.", "AbortError");
            }
            options.onFinished?.();
        } finally {
            options.signal?.removeEventListener("abort", abort);
        }
    }

    private writeMessage(message: Record<string, unknown>): void {
        if (!this.child || !this.child.stdin.writable) {
            throw new Error("O serviço de voz não está disponível.");
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    stop(): void {
        const error = new Error("O serviço de voz foi encerrado.");
        this.rejectStartup?.(error);
        this.startupPromise = null;
        if (!this.child) {
            return;
        }

        for (const request of this.pending.values()) {
            request.removeAbortListener?.();
            request.reject(error);
        }

        this.pending.clear();

        this.stopPlayback();
        for (const playback of this.pendingPlayback.values()) {
            playback.removeAbortListener?.();
            playback.reject(error);
        }
        this.pendingPlayback.clear();
        this.child.stdin.end();
        this.child.kill();
        this.child = null;
        this.ready = false;
        this.persistentPlaybackAvailable = false;
    }
}
