import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SpeechQueue } from "../src/speech/speech-queue.ts";
import { SpeechChunker } from "../src/speech/speech_chunker.ts";
import type { TextToSpeechService } from "../src/speech/text-to-speech.ts";

type SynthesisCall = {
    text: string;
    signal?: AbortSignal;
};

test("SpeechChunker acumula texto parcial e respeita uma fronteira natural", () => {
    const chunker = new SpeechChunker(10, 40);

    assert.deepEqual(chunker.push("Uma frase"), []);
    assert.deepEqual(chunker.push(" completa. Próxima"), ["Uma frase completa."]);
    assert.deepEqual(chunker.flush(), ["Próxima"]);
    assert.deepEqual(chunker.flush(), []);
});

test("SpeechChunker prefere espaço no corte forçado e preserva todo o texto", () => {
    const chunker = new SpeechChunker(10, 20);

    assert.deepEqual(chunker.push("12345678901 12345678901"), [
        "12345678901",
    ]);
    assert.deepEqual(chunker.flush(), ["12345678901"]);
});

test("SpeechChunker faz corte rígido quando uma palavra excede o máximo", () => {
    const chunker = new SpeechChunker(5, 10);

    assert.deepEqual(chunker.push("abcdefghijklmnop"), ["abcdefghij"]);
    assert.deepEqual(chunker.flush(), ["klmnop"]);
});

test("SpeechQueue cancela a síntese ativa e descarta textos pendentes", async () => {
    const calls: SynthesisCall[] = [];
    let synthesisStartCount = 0;
    let firstPlaybackCount = 0;
    let playbackEndCount = 0;

    const fakeTts = {
        synthesize(text: string, signal?: AbortSignal): Promise<string> {
            calls.push({ text, signal });

            return new Promise((_resolve, reject) => {
                const abort = (): void => {
                    reject(signal?.reason ?? new DOMException(
                        "Síntese cancelada.",
                        "AbortError",
                    ));
                };

                if (signal?.aborted) {
                    abort();
                    return;
                }

                signal?.addEventListener("abort", abort, { once: true });
            });
        },
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
        {
            onSynthesisStart: () => {
                synthesisStartCount += 1;
            },
            onFirstPlayback: () => {
                firstPlaybackCount += 1;
            },
            onPlaybackEnd: () => {
                playbackEndCount += 1;
            },
        },
    );

    queue.enqueue("   ");
    assert.equal(queue.isSpeaking(), false);
    assert.equal(calls.length, 0);

    queue.enqueue("  Primeiro trecho.  ");
    queue.enqueue("Trecho que ainda está aguardando.");

    assert.equal(queue.isSpeaking(), true);
    assert.equal(calls.length, 1);
    assert.equal(synthesisStartCount, 1);
    assert.equal(calls[0]?.text, "Primeiro trecho.");

    await queue.interrupt();
    await queue.waitUntilIdle();

    assert.equal(calls[0]?.signal?.aborted, true);
    assert.equal(calls.length, 1);
    assert.equal(queue.isSpeaking(), false);
    assert.equal(firstPlaybackCount, 0);
    assert.equal(playbackEndCount, 0);
});

test("SpeechQueue remove áudio produzido depois de uma interrupção", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "ultron-speech-characterization-"),
    );
    const staleAudio = path.join(temporaryRoot, "stale.wav");
    await writeFile(staleAudio, Buffer.from("RIFF"));

    let resolveSynthesis: ((audioPath: string) => void) | undefined;
    let synthesisSignal: AbortSignal | undefined;
    const fakeTts = {
        synthesize(_text: string, signal?: AbortSignal): Promise<string> {
            synthesisSignal = signal;
            return new Promise(resolve => {
                resolveSynthesis = resolve;
            });
        },
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
    );

    try {
        queue.enqueue("Resposta que ficará obsoleta.");
        await queue.interrupt();

        assert.equal(synthesisSignal?.aborted, true);
        assert.ok(resolveSynthesis);
        resolveSynthesis(staleAudio);

        await queue.waitUntilIdle();
        await assert.rejects(
            () => access(staleAudio),
            (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
        assert.equal(queue.isSpeaking(), false);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("SpeechQueue sinaliza falha de síntese sem mudar seu contrato tolerante", async () => {
    let synthesisErrors = 0;
    const queue = new SpeechQueue(
        {
            async synthesize(): Promise<string> {
                throw new Error("síntese indisponível");
            },
        } as unknown as TextToSpeechService,
        {
            onSynthesisError: () => {
                synthesisErrors += 1;
            },
        },
    );

    queue.enqueue("Notificação que não será sintetizada.");
    await queue.waitUntilIdle();

    assert.equal(synthesisErrors, 1);
    assert.equal(queue.isSpeaking(), false);
});
