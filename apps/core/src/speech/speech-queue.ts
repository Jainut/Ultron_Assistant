import { unlink } from "node:fs/promises";

import {
    TextToSpeechService,
} from "./text-to-speech.ts";

import {
    playAudio,
    stopAudio,
} from "./audio_player.ts";
import { performance } from "node:perf_hooks";
import { perf } from "../utils/performance.ts";
import { debugLog } from "../utils/debug.ts";
import type { PlaybackReference } from "./playback-reference.ts";


export interface SpeechQueueOptions {
    onSynthesisStart?: () => void;
    onFirstPlayback?: () => void;
    onPlaybackEnd?: () => void;
    /** Executado somente quando o player confirma que o WAV começou. */
    onPlaybackChunkStart?: (reference: PlaybackReference) => void;
    /** Executado no terminal do player, antes de o WAV ser removido. */
    onPlaybackChunkEnd?: (reference: PlaybackReference) => void;
    /** Observabilidade sem alterar o contrato tolerante a falhas da fila. */
    onSynthesisError?: () => void;
    onPlaybackError?: () => void;
}

interface QueuedAudio {
    readonly path: string;
    readonly generation: number;
}


export class SpeechQueue {
    private readonly textQueue: string[] = [];
    private readonly audioQueue: QueuedAudio[] = [];

    private synthesizing = false;
    private playing = false;

    private firstPlaybackStarted = false;
    private firstSynthesisStarted = false;

    /*
     * Cada interrupt() incrementa esse número.
     *
     * Isso permite identificar áudios que
     * terminaram de ser sintetizados depois
     * que a resposta já foi cancelada.
     */
    private generation = 0;
    private activeSynthesisController: AbortController | null = null;
    private speakingAnnounced = false;

    private readonly idleResolvers:
        Array<() => void> = [];


    constructor(
        private readonly tts:
            TextToSpeechService,

        private readonly options:
            SpeechQueueOptions = {},
    ) {}


    enqueue(text: string): void {
        const normalized =
            text.trim();

        if (!normalized) {
            return;
        }

        this.textQueue.push(
            normalized,
        );

        void this.startSynthesis();
    }


    reset(): void {
        this.firstPlaybackStarted =
            false;
        this.firstSynthesisStarted = false;
    }


    isSpeaking(): boolean {
        return (
            this.playing ||
            this.synthesizing ||
            this.textQueue.length > 0 ||
            this.audioQueue.length > 0
        );
    }


    async interrupt(): Promise<void> {
        /*
         * Invalida qualquer síntese
         * pertencente à resposta anterior.
         */
        this.generation++;
        this.activeSynthesisController?.abort();
        this.activeSynthesisController = null;

        /*
         * Remove textos ainda esperando
         * para serem sintetizados.
         */
        this.textQueue.length = 0;

        /*
         * Guarda os WAVs já sintetizados
         * que estavam esperando playback.
         */
        const queuedAudio = [
            ...this.audioQueue,
        ];

        this.audioQueue.length = 0;

        /*
         * Para imediatamente o áudio atual.
         */
        if (typeof this.tts.stopPlayback === "function") {
            this.tts.stopPlayback();
        } else {
            // Compatibilidade com doubles antigos e implementações legadas.
            stopAudio();
        }

        /*
         * Remove os arquivos que não
         * serão mais reproduzidos.
         */
        await Promise.all(
            queuedAudio.map(
                audio =>
                    unlink(
                        audio.path,
                    ).catch(
                        () => undefined,
                    ),
            ),
        );

        this.resolveIdleIfNeeded();
    }


    async waitUntilIdle(): Promise<void> {
        if (this.isIdle()) {
            return;
        }

        return new Promise<void>(
            resolve => {
                this.idleResolvers.push(
                    resolve,
                );
            },
        );
    }


    private async startSynthesis():
        Promise<void> {

        if (this.synthesizing) {
            return;
        }

        this.synthesizing = true;

        try {
            while (
                this.textQueue.length > 0
            ) {
                const text =
                    this.textQueue.shift();

                if (!text) {
                    continue;
                }

                /*
                 * Salva a geração à qual
                 * este TTS pertence.
                 */
                const requestGeneration =
                    this.generation;

                try {
                    if (!this.firstSynthesisStarted) {
                        this.firstSynthesisStarted = true;
                        this.options.onSynthesisStart?.();
                    }
                    const synthesisController = new AbortController();
                    this.activeSynthesisController = synthesisController;
                    const synthesisStartedAt = performance.now();
                    const audioPath =
                        await this.tts.synthesize(
                            text,
                            synthesisController.signal,
                        );

                    if (!this.firstPlaybackStarted) {
                        perf.record(
                            "TTS first chunk",
                            performance.now() - synthesisStartedAt,
                        );
                    }

                    /*
                     * Houve interrupt()
                     * enquanto o Kokoro
                     * estava trabalhando.
                     */
                    if (
                        requestGeneration !==
                        this.generation
                    ) {
                        await unlink(
                            audioPath,
                        ).catch(
                            () => undefined,
                        );

                        continue;
                    }

                    this.audioQueue.push({
                        path: audioPath,
                        generation: requestGeneration,
                    });

                    /*
                     * Não aguardamos.
                     *
                     * O Kokoro pode continuar
                     * sintetizando enquanto
                     * outro áudio toca.
                     */
                    void this.startPlayback();

                } catch (error) {
                    if (
                        error instanceof DOMException
                        && error.name === "AbortError"
                    ) {
                        continue;
                    }

                    this.options.onSynthesisError?.();

                    console.error(
                        "[SpeechQueue] " +
                        "Erro ao sintetizar:",
                        error,
                    );
                } finally {
                    this.activeSynthesisController = null;
                }
            }

        } finally {
            this.synthesizing =
                false;

            /*
             * Pode ter entrado texto na fila
             * exatamente quando estávamos
             * finalizando este worker.
             */
            if (
                this.textQueue.length > 0
            ) {
                void this.startSynthesis();
            }

            this.resolveIdleIfNeeded();
        }
    }


    private async startPlayback():
        Promise<void> {

        if (this.playing) {
            return;
        }

        this.playing = true;

        try {
            while (
                this.audioQueue.length > 0
            ) {
                const audio =
                    this.audioQueue.shift();

                if (!audio) {
                    continue;
                }

                const audioPath = audio.path;
                let playbackReference: PlaybackReference | null = null;

                try {
                    const playbackStartedAt = performance.now();
                    const announcePlayback = (): void => {
                        if (playbackReference) return;

                        /*
                         * Um playback_started pode chegar depois de um
                         * interrupt/flush. Não deixa essa geração antiga
                         * substituir a referência acústica da nova fala.
                         */
                        if (audio.generation !== this.generation) {
                            this.tts.stopPlayback?.();
                            return;
                        }

                        playbackReference = {
                            path: audioPath,
                            generation: audio.generation,
                            startedAtUnixMs: Date.now(),
                        };

                        if (!this.firstPlaybackStarted) {
                            this.firstPlaybackStarted = true;
                            this.options.onFirstPlayback?.();
                            this.speakingAnnounced = true;
                        }

                        try {
                            this.options.onPlaybackChunkStart?.(
                                playbackReference,
                            );
                        } catch (error) {
                            // Observabilidade/AEC não pode derrubar a voz.
                            debugLog(
                                "[SpeechQueue] Callback de início de chunk falhou:",
                                error,
                            );
                        }
                    };
                    if (typeof this.tts.play === "function") {
                        await this.tts.play(audioPath, {
                            onStarted: announcePlayback,
                        });
                    } else {
                        // Compatibilidade com serviços/doubles pré-playback-v1.
                        announcePlayback();
                        await playAudio(audioPath);
                    }
                    perf.record(
                        "Audio playback",
                        performance.now() - playbackStartedAt,
                    );

                } catch (error) {
                    this.options.onPlaybackError?.();
                    console.error(
                        "[SpeechQueue] " +
                        "Erro no playback:",
                        error,
                    );

                } finally {
                    if (playbackReference) {
                        try {
                            this.options.onPlaybackChunkEnd?.(
                                playbackReference,
                            );
                        } catch (error) {
                            // O WAV ainda deve ser liberado mesmo se o listener falhar.
                            debugLog(
                                "[SpeechQueue] Callback de fim de chunk falhou:",
                                error,
                            );
                        }
                    }

                    /*
                     * Arquivo usado ou
                     * interrompido:
                     * podemos apagar.
                     */
                    await unlink(
                        audioPath,
                    ).catch(
                        () => undefined,
                    );
                }
            }

        } finally {
            this.playing =
                false;

            /*
             * Evita race condition:
             * talvez algum áudio tenha
             * entrado enquanto este worker
             * estava finalizando.
             */
            if (
                this.audioQueue.length > 0
            ) {
                void this.startPlayback();
            }

            this.resolveIdleIfNeeded();
        }
    }


    private isIdle(): boolean {
        return (
            !this.synthesizing &&
            !this.playing &&
            this.textQueue.length === 0 &&
            this.audioQueue.length === 0
        );
    }


    private resolveIdleIfNeeded(): void {
        if (!this.isIdle()) {
            return;
        }

        while (
            this.idleResolvers.length > 0
        ) {
            const resolve =
                this.idleResolvers.shift();

            resolve?.();
        }

        if (this.speakingAnnounced) {
            this.speakingAnnounced = false;
            this.options.onPlaybackEnd?.();
        }
    }
}
