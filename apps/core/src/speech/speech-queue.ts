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


interface SpeechQueueOptions {
    onFirstPlayback?: () => void;
    onPlaybackEnd?: () => void;
}


export class SpeechQueue {
    private readonly textQueue: string[] = [];
    private readonly audioQueue: string[] = [];

    private synthesizing = false;
    private playing = false;

    private firstPlaybackStarted = false;

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
        stopAudio();

        /*
         * Remove os arquivos que não
         * serão mais reproduzidos.
         */
        await Promise.all(
            queuedAudio.map(
                audioPath =>
                    unlink(
                        audioPath,
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

                    this.audioQueue.push(
                        audioPath,
                    );

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
                const audioPath =
                    this.audioQueue.shift();

                if (!audioPath) {
                    continue;
                }

                if (
                    !this.firstPlaybackStarted
                ) {
                    this.firstPlaybackStarted =
                        true;

                    this.options
                        .onFirstPlayback?.();
                    this.speakingAnnounced = true;
                }

                try {
                    const playbackStartedAt = performance.now();
                    await playAudio(
                        audioPath,
                    );
                    perf.record(
                        "Audio playback",
                        performance.now() - playbackStartedAt,
                    );

                } catch (error) {
                    console.error(
                        "[SpeechQueue] " +
                        "Erro no playback:",
                        error,
                    );

                } finally {
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
