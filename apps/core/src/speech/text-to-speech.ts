import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { servicePath } from "../config/runtime.ts";
import { awaitServiceOperation, serviceError as normalizeServiceError, timedServiceOperation } from "../system/service-lifecycle.ts";
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
    synthesisTimeoutMs?: number;
    playbackTimeoutMs?: number;
    playbackCancelTimeoutMs?: number;
    /** Isolated fallback tests must never launch a real audio player. */
    playFallback?: typeof playAudioFallback;
    stopFallback?: typeof stopAudioFallback;
    /** Diagnostics need player-confirmed timestamps, not the legacy estimate. */
    requirePersistentPlayback?: boolean;
}

interface PendingPlayback extends PlaybackCallbacks {
    resolve: () => void;
    reject: (error: unknown) => void;
    removeAbortListener?: () => void;
    abortReason?: unknown;
    started: boolean;
    cancelRequested?: boolean;
    fallbackSafe?: boolean;
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
    private readonly failureListeners = new Set<(error: Error) => void>();
    private failCurrentProcess: ((error: Error) => void) | null = null;
    private readonly deadlines = new Map<string, NodeJS.Timeout>();
    private readonly cancelledSynthesis = new Set<string>();
    private readonly pendingFlushes = new Set<string>();
    private readonly fallbackControllers = new Set<AbortController>();

    private readonly pending = new Map<
        string,
        PendingRequest
    >();

    private readonly pendingPlayback = new Map<string, PendingPlayback>();

    constructor(private readonly options: TextToSpeechServiceOptions = {}) {}

    isReady(): boolean {
        return Boolean(this.child && !this.child.killed && this.ready);
    }

    onFailure(listener: (error: Error) => void): () => void {
        this.failureListeners.add(listener);
        return () => this.failureListeners.delete(listener);
    }

    async healthCheck(signal?: AbortSignal): Promise<boolean> {
        signal?.throwIfAborted();
        // The existing JSON protocol has no ping. Report only owned-process
        // readiness; do not claim that this probes a busy/hung synthesis engine.
        return this.isReady();
    }

    start(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return Promise.reject(signal.reason);
        if (this.isReady()) {
            return Promise.resolve();
        }

        if (this.startupPromise) {
            return signal ? awaitServiceOperation(this.startupPromise, signal) : this.startupPromise;
        }

        const startupPromise = new Promise<void>((resolve, reject) => {
            let startupSettled = false;
            let startupTimeout: NodeJS.Timeout | undefined;

            const clearStartup = (): void => {
                if (startupTimeout) {
                    clearTimeout(startupTimeout);
                    startupTimeout = undefined;
                }
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
                if (this.child === child) serviceError("[Kokoro]", chunk.toString());
            });

            const handleProcessError = (error: Error): void => {
                if (this.child === child) {
                    this.ready = false;
                    this.persistentPlaybackAvailable = false;
                    this.child = null;
                    this.failCurrentProcess = null;
                    this.clearDeadlines();
                    this.cancelFallbacks(error);

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
                    try { child.kill(); } catch { /* Already exited. */ }
                    this.notifyFailure(error);
                }
                rejectStartup(error);
            };
            this.failCurrentProcess = handleProcessError;
            child.once("error", handleProcessError);
            child.once("exit", code => handleProcessError(new Error(
                `O serviço Kokoro encerrou com código ${code}.`,
            )));
            // EPIPE can arrive on stdin without a child-process error/close.
            child.stdin.on("error", handleProcessError);
            child.stdout.on("error", handleProcessError);
            child.stderr.on("error", handleProcessError);

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
                    this.failCurrentProcess = null;
                    this.clearDeadlines();
                }

                const error = new Error(
                    `O serviço Kokoro encerrou com código ${code}.`,
                );

                if (!startupSettled) {
                    rejectStartup(error);
                }

                if (ownsCurrentProcess) {
                    this.cancelFallbacks(error);
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
                    this.notifyFailure(error);
                }
            });
        });

        this.startupPromise = startupPromise;
        const abort = (): void => {
            if (this.startupPromise === startupPromise && !this.ready) {
                this.stop(normalizeServiceError(signal?.reason
                    ?? new DOMException("Inicialização TTS cancelada.", "AbortError")));
            }
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const clearStartupPromise = (): void => {
            signal?.removeEventListener("abort", abort);
            if (this.startupPromise === startupPromise) {
                this.startupPromise = null;
            }
        };
        void startupPromise.then(clearStartupPromise, clearStartupPromise);
        return startupPromise;
    }

    private notifyFailure(error: Error): void {
        for (const listener of this.failureListeners) {
            try { listener(error); } catch { /* Observer isolation. */ }
        }
    }

    private duration(configured: number | undefined, fallback: number): number {
        return configured !== undefined && Number.isFinite(configured) && configured > 0
            ? configured : fallback;
    }

    private armDeadline(id: string, label: string, timeoutMs: number): void {
        this.disarmDeadline(id);
        const child = this.child;
        if (!child) return;
        this.deadlines.set(id, setTimeout(() => {
            this.deadlines.delete(id);
            if (this.child !== child) return;
            const error = Object.assign(new Error(`${label}: tempo limite excedido.`), { code: "ETIMEDOUT" });
            this.failCurrentProcess?.(error);
        }, timeoutMs));
    }

    private disarmDeadline(id: string): void {
        const timer = this.deadlines.get(id);
        if (timer) clearTimeout(timer);
        this.deadlines.delete(id);
    }

    private clearDeadlines(): void {
        for (const timer of this.deadlines.values()) clearTimeout(timer);
        this.deadlines.clear();
        this.cancelledSynthesis.clear();
        this.pendingFlushes.clear();
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

        if (this.pendingFlushes.has(message.id)) {
            if (message.type === "playback_flushed") {
                this.pendingFlushes.delete(message.id);
                this.disarmDeadline(message.id);
            } else if (message.type === "error") {
                this.failCurrentProcess?.(new Error("O player não confirmou o flush de áudio."));
            }
            return;
        }
        if (this.cancelledSynthesis.has(message.id)) {
            if (message.type === "audio_ready" || message.type === "error") {
                this.cancelledSynthesis.delete(message.id);
                this.disarmDeadline(message.id);
            }
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
        this.disarmDeadline(message.id);
        request.removeAbortListener?.();

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
        this.disarmDeadline(id);
        playback.removeAbortListener?.();

        if (message.type === "error") {
            // Only an explicit backend refusal before any start/cancel is safe
            // to replay on the legacy player. Missing ACK/timeout is ambiguous.
            playback.fallbackSafe = !playback.started && !playback.cancelRequested;
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
                request.removeAbortListener?.();
                // Synthesis cancellation is cooperative in Kokoro; retain its
                // original bounded deadline until Python confirms the terminal
                // result, rather than killing a valid model mid-kernel in 1s.
                this.cancelledSynthesis.add(id);
                try { this.writeMessage({ id, type: "cancel" }); }
                catch (error) { this.failCurrentProcess?.(normalizeServiceError(error)); }
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
            this.armDeadline(id, "TTS synthesis", this.duration(this.options.synthesisTimeoutMs, 60_000));

            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) {
                abort();
                return;
            }

            const message = {
                id,
                type: "speak",
                text,
                output: audioPath,
            };

            try { this.writeMessage(message); }
            catch (error) {
                this.failCurrentProcess?.(normalizeServiceError(error));
                this.pending.delete(id);
                this.disarmDeadline(id);
                removeAbortListener?.();
                reject(error);
            }
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
                    playback.cancelRequested = true;
                    playback.abortReason = options.signal?.reason
                        ?? new DOMException("Playback cancelado.", "AbortError");
                    this.armDeadline(id, "TTS cancel ACK", this.duration(this.options.playbackCancelTimeoutMs, 1_500));
                    try { this.writeMessage({ id, type: "cancel_playback" }); }
                    catch (error) { this.failCurrentProcess?.(normalizeServiceError(error)); }
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
                this.armDeadline(id, "TTS playback", this.duration(this.options.playbackTimeoutMs, 120_000));

                try {
                    this.writeMessage({ id, type: "play", path: audioPath });
                    options.signal?.addEventListener("abort", abort, { once: true });
                    if (options.signal?.aborted) abort();
                } catch (error) {
                    this.pendingPlayback.delete(id);
                    this.disarmDeadline(id);
                    removeAbortListener?.();
                    reject(error);
                }
            });
        } catch (error) {
            // Se o backend recusou antes de playback_started, ainda é seguro
            // tentar o SoundPlayer legado sem duplicar áudio já iniciado.
            if (
                playbackState !== undefined
                && playbackState.fallbackSafe === true
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
        this.cancelFallbacks(new DOMException("Playback cancelado.", "AbortError"));
        if (!this.persistentPlaybackAvailable || !this.child) {
            (this.options.stopFallback ?? stopAudioFallback)();
            return;
        }

        try {
            const timeoutMs = this.duration(this.options.playbackCancelTimeoutMs, 1_500);
            for (const [id, playback] of this.pendingPlayback) {
                // Preserve legacy resolution on playback_cancelled for callers
                // without an AbortSignal, but never replay a cancelled request.
                if (!playback.cancelRequested) {
                    playback.cancelRequested = true;
                    this.armDeadline(id, "TTS flush terminal ACK", timeoutMs);
                }
            }
            const flushId = randomUUID();
            this.pendingFlushes.add(flushId);
            this.armDeadline(flushId, "TTS flush ACK", timeoutMs);
            this.writeMessage({
                id: flushId,
                type: "flush_playback",
            });
        } catch (error) {
            this.failCurrentProcess?.(normalizeServiceError(error));
            for (const [id, playback] of this.pendingPlayback) {
                this.pendingPlayback.delete(id);
                this.disarmDeadline(id);
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
        const child = this.child;
        const controller = new AbortController();
        this.fallbackControllers.add(controller);
        const signal = options.signal
            ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        try {
            await timedServiceOperation(async signal => {
                const abort = (): void => {
                    aborted = true;
                    (this.options.stopFallback ?? stopAudioFallback)();
                };
                signal.addEventListener("abort", abort, { once: true });
                try {
                    signal.throwIfAborted();
                    options.onStarted?.();
                    await awaitServiceOperation((this.options.playFallback ?? playAudioFallback)(audioPath), signal);
                } finally {
                    signal.removeEventListener("abort", abort);
                }
            }, { signal,
                timeoutMs: this.duration(this.options.playbackTimeoutMs, 120_000), label: "TTS fallback playback" });
            options.onFinished?.();
        } catch (error) {
            if (aborted) options.onCancelled?.();
            if (controller.signal.aborted && error instanceof DOMException
                && error.name === "AbortError" && !options.signal?.aborted) return;
            if (aborted && !signal.aborted && this.child === child) {
                this.failCurrentProcess?.(normalizeServiceError(error));
            }
            throw error;
        } finally {
            this.fallbackControllers.delete(controller);
        }
    }

    private cancelFallbacks(error: Error): void {
        for (const controller of this.fallbackControllers) controller.abort(error);
    }

    private writeMessage(message: Record<string, unknown>): void {
        if (!this.child || !this.child.stdin.writable) {
            throw new Error("O serviço de voz não está disponível.");
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    stop(error: Error = new Error("O serviço de voz foi encerrado.")): void {
        this.cancelFallbacks(error);
        this.rejectStartup?.(error);
        this.startupPromise = null;
        if (!this.child) {
            this.clearDeadlines();
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
        const child = this.child;
        this.child = null;
        this.failCurrentProcess = null;
        this.clearDeadlines();
        this.ready = false;
        this.persistentPlaybackAvailable = false;
        try { child.stdin.end(); } catch { /* Already closed. */ }
        try { child.kill(); } catch { /* Already exited. */ }
    }
}
