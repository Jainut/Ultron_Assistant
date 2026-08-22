/**
 * Identifica um WAV enquanto ele está efetivamente sendo reproduzido.
 *
 * `generation` pertence à época de cancelamento da SpeechQueue. Assim, o
 * capturador consegue descartar referências atrasadas sem confundi-las com a
 * resposta que começou depois de um barge-in.
 */
export interface PlaybackReference {
    readonly path: string;
    readonly generation: number;
    readonly startedAtUnixMs: number;
}
