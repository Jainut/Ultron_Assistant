import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { runtimeConfig } from "../config/runtime.ts";
import { SpeechQueue } from "../speech/speech-queue.ts";
import { TextToSpeechService } from "../speech/text-to-speech.ts";
import {
    buildCalibrationReport,
    CALIBRATION_CONDITIONS,
    parseCalibrationArgs,
    type CalibrationCondition,
    type CalibrationSample,
    type EchoTelemetrySample,
} from "./barge-in-calibration.ts";
import {
    CalibrationCaptureClient,
    type CalibrationCaptureMessage,
} from "./calibration-capture-client.ts";

const PLAYBACK_PHRASE = [
    "Todos os sistemas permanecem operacionais.",
    "Estou analisando os sensores locais, verificando conexões e preparando o próximo relatório.",
    "Este áudio continuará por alguns instantes para testar a interrupção de voz com segurança.",
].join(" ");

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(error: unknown): void;
}

interface ActivePlayback {
    readonly started: Deferred<void>;
    readonly ended: Deferred<void>;
    readonly speech: Deferred<void>;
    startedAtMs?: number;
    endedAtMs?: number;
    cueAtMs?: number;
    speechAtMs?: number;
    detectionLatencyMs?: number;
    queueAgeMs?: number;
}

interface PlaybackObservation {
    readonly playbackSeconds: number;
    readonly speechStart: boolean;
    readonly speechBeforeCue: boolean;
    readonly detectionLatencyMs?: number;
    readonly queueAgeMs?: number;
    readonly stopLatencyMs?: number;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    // A process can fail between playback_started and the next await. Keep a
    // rejection observer attached even while this deferred is not the active wait.
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
}

export async function waitWithAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
): Promise<T> {
    let onAbort: (() => void) | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                onAbort = (): void => reject(signal.reason);
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
            }),
        ]);
    } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const finish = (): void => {
            signal.removeEventListener("abort", abort);
            resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        const abort = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve().then(() => {
            if (signal.aborted) abort();
        });
    });
}

async function withTimeout<T>(
    promise: Promise<T>,
    milliseconds: number,
    message: string,
    signal: AbortSignal,
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await waitWithAbort(Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), milliseconds);
            }),
        ]), signal);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

type PlaybackCapture = Pick<
    CalibrationCaptureClient,
    "onMessage" | "setPlaybackActive" | "startPlaybackReference"
    | "endPlaybackReference" | "pause" | "resume"
>;

export class GuidedPlayback {
    private readonly queue: SpeechQueue;
    private active: ActivePlayback | null = null;
    private fatalError: unknown = null;
    private readonly unsubscribeCapture: () => void;
    private readonly onAbort: () => void;
    readonly echoTelemetry: EchoTelemetrySample[] = [];

    constructor(
        tts: TextToSpeechService,
        private readonly capture: PlaybackCapture,
        private readonly signal: AbortSignal,
    ) {
        this.queue = new SpeechQueue(tts, {
            onFirstPlayback: () => {
                const active = this.active;
                if (!active) return;
                try {
                    this.capture.setPlaybackActive(true);
                    active.startedAtMs = performance.now();
                    active.started.resolve();
                } catch (error) {
                    this.failActive(error);
                    void this.queue.interrupt();
                }
            },
            onPlaybackChunkStart: reference => {
                try {
                    this.capture.startPlaybackReference(reference);
                } catch (error) {
                    this.failActive(error);
                    void this.queue.interrupt();
                }
            },
            onPlaybackChunkEnd: reference => {
                try {
                    this.capture.endPlaybackReference(reference);
                } catch (error) {
                    this.failActive(error);
                }
            },
            onPlaybackEnd: () => {
                const active = this.active;
                try {
                    this.capture.setPlaybackActive(false);
                    this.capture.pause();
                } catch {
                    // A fatal capture event has already failed the active run.
                }
                if (!active) return;
                active.endedAtMs = performance.now();
                active.ended.resolve();
            },
            onSynthesisError: () => {
                this.failActive(new Error(
                    "O Kokoro não conseguiu sintetizar a frase de calibração.",
                ));
            },
            onPlaybackError: () => {
                this.failActive(new Error(
                    "O player não conseguiu reproduzir a frase de calibração.",
                ));
            },
        });

        this.unsubscribeCapture = this.capture.onMessage(message => this.handleCaptureMessage(message));
        this.onAbort = (): void => {
            void this.queue.interrupt();
            const error = this.signal.reason
                ?? new DOMException("Calibração cancelada.", "AbortError");
            this.failActive(error);
        };
        this.signal.addEventListener("abort", this.onAbort, { once: true });
        if (this.signal.aborted) this.onAbort();
    }

    private handleCaptureMessage(message: CalibrationCaptureMessage): void {
        if (message.type === "echo_suppressed") {
            this.echoTelemetry.push({
                correlation: message.correlation,
                residualRatio: message.residualRatio,
                delayMs: message.delayMs,
                processingMs: message.processingMs,
                queueAgeMs: message.queueAgeMs,
            });
            return;
        }
        if (message.type === "privacy_violation" || message.type === "error") {
            const error = new Error(
                message.type === "privacy_violation"
                    ? "Falha de privacidade: o capturador tentou emitir áudio."
                    : "O capturador informou um erro.",
            );
            this.failActive(error);
            void this.queue.interrupt();
            return;
        }
        if (message.type !== "speech_start" || !message.playback) return;
        const active = this.active;
        if (!active || active.speechAtMs !== undefined) return;
        active.speechAtMs = performance.now();
        active.detectionLatencyMs = message.detectionLatencyMs;
        active.queueAgeMs = message.queueAgeMs;
        active.speech.resolve();
        void this.queue.interrupt();
    }

    private failActive(error: unknown): void {
        this.fatalError ??= error;
        const active = this.active;
        if (!active) return;
        active.started.reject(error);
        active.ended.reject(error);
        active.speech.resolve();
    }

    async runEchoPlayback(): Promise<PlaybackObservation> {
        return this.runPlayback();
    }

    async runInterruptionPlayback(cueDelayMs: number): Promise<PlaybackObservation> {
        return this.runPlayback(cueDelayMs);
    }

    private async runPlayback(cueDelayMs?: number): Promise<PlaybackObservation> {
        this.signal.throwIfAborted();
        if (this.fatalError) throw this.fatalError;
        if (this.active) throw new Error("Já existe um playback de calibração ativo.");
        const roundController = new AbortController();
        const roundSignal = AbortSignal.any([this.signal, roundController.signal]);
        const active: ActivePlayback = {
            started: deferred<void>(),
            ended: deferred<void>(),
            speech: deferred<void>(),
        };
        this.active = active;

        try {
            this.capture.resume();
            this.queue.reset();
            this.queue.enqueue(PLAYBACK_PHRASE);
            await withTimeout(
                active.started.promise,
                60_000,
                "A frase de calibração não começou em 60 segundos.",
                roundSignal,
            );

            if (cueDelayMs !== undefined) {
                await Promise.race([
                    delay(cueDelayMs, roundSignal),
                    active.ended.promise,
                ]);
                if (active.endedAtMs === undefined) {
                    active.cueAtMs = performance.now();
                    process.stdout.write("\n>>> FALE AGORA: diga 'Ultron, para' <<<\n");
                    await Promise.race([
                        active.speech.promise,
                        active.ended.promise,
                        delay(4_000, roundSignal),
                    ]);
                    if (active.endedAtMs === undefined && active.speechAtMs === undefined) {
                        await this.queue.interrupt();
                    }
                }
            }

            await withTimeout(
                active.ended.promise,
                30_000,
                "O playback de calibração não encerrou.",
                roundSignal,
            );
            await withTimeout(
                this.queue.waitUntilIdle(),
                5_000,
                "A fila de voz não ficou ociosa após o playback.",
                roundSignal,
            );
            if (this.fatalError) throw this.fatalError;

            const startedAt = active.startedAtMs ?? active.endedAtMs ?? 0;
            const endedAt = active.endedAtMs ?? startedAt;
            const speechBeforeCue = active.speechAtMs !== undefined
                && (active.cueAtMs === undefined || active.speechAtMs < active.cueAtMs);
            return {
                playbackSeconds: Math.max(0, endedAt - startedAt) / 1_000,
                speechStart: active.speechAtMs !== undefined,
                speechBeforeCue,
                ...(active.detectionLatencyMs !== undefined
                    ? { detectionLatencyMs: active.detectionLatencyMs }
                    : {}),
                ...(active.queueAgeMs !== undefined
                    ? { queueAgeMs: active.queueAgeMs }
                    : {}),
                ...(active.speechAtMs !== undefined
                    ? { stopLatencyMs: Math.max(0, endedAt - active.speechAtMs) }
                    : {}),
            };
        } finally {
            roundController.abort();
            await this.queue.interrupt();
            try {
                this.capture.setPlaybackActive(false);
                this.capture.pause();
            } catch {
                // Preserve the original failure from the capture process.
            }
            this.active = null;
        }
    }

    async stop(): Promise<void> {
        this.signal.removeEventListener("abort", this.onAbort);
        this.unsubscribeCapture();
        this.failActive(new DOMException("Calibração cancelada.", "AbortError"));
        await this.queue.interrupt();
    }
}

function yes(answer: string, defaultValue: boolean): boolean {
    const normalized = answer.trim().toLowerCase();
    if (!normalized) return defaultValue;
    return ["s", "sim", "y", "yes"].includes(normalized);
}

async function portInUse(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        const finish = (value: boolean): void => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(300);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}

export async function assertCalibrationIsolation(
    ports: { hudPort: number; whisperPort: number },
    probe: (port: number) => Promise<boolean> = portInUse,
): Promise<void> {
    // HUD can move to another port when occupied; the Whisper listener still
    // identifies an active voice instance. Reject either busy port conservatively.
    const candidates = [...new Set([ports.hudPort, ports.whisperPort])];
    const busy = await Promise.all(candidates.map(async port => ({
        port,
        active: await probe(port),
    })));
    const active = busy.find(candidate => candidate.active);
    if (active) {
        throw new Error(
            `Há um serviço ativo na porta ${active.port}. Encerre o Ultron/Whisper antes da calibração.`,
        );
    }
}

function printUsage(): void {
    process.stdout.write([
        "Uso: npm run calibrate:barge-in -- [opções]",
        "",
        "  --quick             1 tentativa e 2 s de eco por condição",
        "  --gate              gate completo: 30 interrupções e 30 min de eco",
        "  --attempts N        tentativas válidas por condição",
        "  --echo-seconds N    segundos de eco por condição",
        "  --output ARQUIVO    grava relatório JSON sanitizado (opt-in)",
        "  --help              mostra esta ajuda",
        "",
    ].join("\n"));
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
        printUsage();
        return;
    }
    const options = parseCalibrationArgs(args);
    if (!process.stdin.isTTY) {
        throw new Error(
            "Execute a calibração em um terminal interativo para confirmar cada tentativa.",
        );
    }
    await assertCalibrationIsolation(runtimeConfig);

    const abortController = new AbortController();
    const capture = new CalibrationCaptureClient();
    const tts = new TextToSpeechService({ requirePersistentPlayback: true });
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let playback: GuidedPlayback | null = null;
    const onSignal = (): void => {
        abortController.abort(new DOMException("Calibração cancelada.", "AbortError"));
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    input.on("SIGINT", onSignal);
    const unsubscribeCapture = capture.onMessage(message => {
        if (message.type === "error" || message.type === "privacy_violation") {
            abortController.abort(new Error(
                "A captura falhou; a calibração foi interrompida sem gerar um resultado favorável.",
            ));
        }
    });

    const samples: CalibrationSample[] = [];
    try {
        process.stdout.write([
            "Calibração isolada de barge-in",
            "- Whisper, IA, HUD, tools e automações NÃO serão iniciados.",
            "- O microfone NÃO será salvo nem transcrito.",
            "- Ajuste o volume manualmente quando solicitado.",
            "",
            "Inicializando Kokoro e capturador...",
        ].join("\n"));
        const [ready] = await waitWithAbort(
            Promise.all([capture.start(), tts.start()]),
            abortController.signal,
        );
        if (!tts.isPersistentPlaybackAvailable()) {
            throw new Error(
                "A calibração requer o player persistente para medir o início real do áudio. O fallback normal do Ultron continua disponível.",
            );
        }
        playback = new GuidedPlayback(tts, capture, abortController.signal);

        process.stdout.write(
            `\nCaptura pronta: detector=${ready.detector}, referência=${ready.echoReference.enabled ? "ativa" : "inativa"}.\n`,
        );

        for (const condition of CALIBRATION_CONDITIONS) {
            abortController.signal.throwIfAborted();
            const distanceDescription = condition.distance === "near"
                ? "perto do microfone"
                : "longe do microfone";
            await input.question(
                `\nAjuste o volume para ${condition.volumePercent}% e fique ${distanceDescription}. Pressione Enter.`,
                { signal: abortController.signal },
            );
            process.stdout.write("Permaneça em silêncio durante a fase de eco.\n");

            let observedEchoSeconds = 0;
            while (observedEchoSeconds < options.echoSecondsPerCondition) {
                const observation = await playback.runEchoPlayback();
                observedEchoSeconds += observation.playbackSeconds;
                samples.push(sampleFromObservation(
                    condition,
                    "echo",
                    observation,
                    {
                        valid: true,
                        expectedSpeech: false,
                        falseBarge: observation.speechStart,
                    },
                ));
            }

            let validAttempts = 0;
            let attemptNumber = 0;
            while (validAttempts < options.attemptsPerCondition) {
                attemptNumber += 1;
                process.stdout.write(
                    `\nTentativa ${validAttempts + 1}/${options.attemptsPerCondition}: aguarde o aviso visual.\n`,
                );
                const cueDelayMs = 900 + (attemptNumber % 4) * 250;
                const observation = await playback.runInterruptionPlayback(cueDelayMs);

                if (observation.speechBeforeCue) {
                    const spokeEarly = yes(await input.question(
                        "Você falou antes do aviso? [s/N] ",
                        { signal: abortController.signal },
                    ), false);
                    samples.push(sampleFromObservation(
                        condition,
                        "interruption",
                        observation,
                        {
                            valid: false,
                            expectedSpeech: false,
                            falseBarge: !spokeEarly,
                        },
                    ));
                    process.stdout.write("Tentativa repetida.\n");
                    continue;
                }

                const actuallySpoke = yes(await input.question(
                    "Você falou após o aviso? [S/n] ",
                    { signal: abortController.signal },
                ), true);
                const valid = actuallySpoke;
                samples.push(sampleFromObservation(
                    condition,
                    "interruption",
                    observation,
                    {
                        valid,
                        expectedSpeech: actuallySpoke,
                        falseBarge: observation.speechStart && !actuallySpoke,
                    },
                ));
                if (valid) {
                    validAttempts += 1;
                    process.stdout.write(
                        observation.speechStart ? "Interrupção detectada.\n" : "Interrupção não detectada.\n",
                    );
                } else {
                    process.stdout.write("Tentativa inválida; será repetida.\n");
                }
            }
        }

        const report = buildCalibrationReport({
            profile: options.profile,
            createdAt: new Date().toISOString(),
            samples,
            echoTelemetry: playback.echoTelemetry,
            capture: {
                detector: ready.detector,
                echoReferenceEnabled: ready.echoReference.enabled,
                maximumDelayMs: ready.echoReference.maximumDelayMs,
                correlationThreshold: ready.echoReference.correlationThreshold,
                residualRatioThreshold: ready.echoReference.residualRatioThreshold,
            },
        });
        process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);

        if (options.outputPath) {
            const outputPath = path.resolve(options.outputPath);
            await mkdir(path.dirname(outputPath), { recursive: true });
            await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
                encoding: "utf8",
                flag: "wx",
            });
            process.stdout.write(`Relatório sanitizado salvo em ${outputPath}\n`);
        } else {
            process.stdout.write("Relatório não salvo (use --output para optar pela gravação).\n");
        }
    } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        input.removeListener("SIGINT", onSignal);
        unsubscribeCapture();
        input.close();
        await playback?.stop().catch(() => undefined);
        capture.stop();
        tts.stop();
    }
}

function sampleFromObservation(
    condition: CalibrationCondition,
    kind: "echo" | "interruption",
    observation: PlaybackObservation,
    classification: Pick<
        CalibrationSample,
        "valid" | "expectedSpeech" | "falseBarge"
    >,
): CalibrationSample {
    return {
        ...condition,
        kind,
        ...classification,
        speechStart: observation.speechStart,
        playbackSeconds: observation.playbackSeconds,
        ...(observation.detectionLatencyMs !== undefined
            ? { detectionLatencyMs: observation.detectionLatencyMs }
            : {}),
        ...(observation.queueAgeMs !== undefined
            ? { queueAgeMs: observation.queueAgeMs }
            : {}),
        ...(observation.stopLatencyMs !== undefined
            ? { stopLatencyMs: observation.stopLatencyMs }
            : {}),
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 1;
        }
    });
}
