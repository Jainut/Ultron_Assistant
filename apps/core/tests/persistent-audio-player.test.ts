import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SpeechQueue } from "../src/speech/speech-queue.ts";
import { supportsPersistentPlayback } from "../src/speech/text-to-speech.ts";
import type {
    PlaybackOptions,
    TextToSpeechService,
} from "../src/speech/text-to-speech.ts";

test("SpeechQueue prefere o player persistente oferecido pelo TTS", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-persistent-player-"));
    const audioPath = path.join(root, "audio.wav");
    await writeFile(audioPath, Buffer.from("RIFF"));
    const played: string[] = [];
    let firstPlayback = 0;
    let announceStarted: (() => void) | undefined;
    let finishPlayback: (() => void) | undefined;
    let playEntered!: () => void;
    const entered = new Promise<void>(resolve => {
        playEntered = resolve;
    });
    const fakeTts = {
        async synthesize(): Promise<string> {
            return audioPath;
        },
        async play(candidate: string, options?: PlaybackOptions): Promise<void> {
            played.push(candidate);
            announceStarted = options?.onStarted;
            playEntered();
            await new Promise<void>(resolve => {
                finishPlayback = resolve;
            });
        },
        stopPlayback(): void {},
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
        { onFirstPlayback: () => { firstPlayback += 1; } },
    );

    try {
        queue.enqueue("Trecho persistente.");
        await entered;
        assert.equal(firstPlayback, 0);
        await access(audioPath);

        announceStarted?.();
        assert.equal(firstPlayback, 1);
        await access(audioPath);

        finishPlayback?.();
        await queue.waitUntilIdle();
        assert.deepEqual(played, [audioPath]);
        await assert.rejects(
            () => access(audioPath),
            (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
    } finally {
        finishPlayback?.();
        await rm(root, { recursive: true, force: true });
    }
});

test("interrupt encaminha flush ao player persistente sem esperar novo processo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-persistent-player-"));
    const audioPath = path.join(root, "audio.wav");
    await writeFile(audioPath, Buffer.from("RIFF"));
    let finishPlayback: (() => void) | undefined;
    let playbackStarted!: () => void;
    const started = new Promise<void>(resolve => {
        playbackStarted = resolve;
    });
    let flushes = 0;
    const fakeTts = {
        async synthesize(): Promise<string> {
            return audioPath;
        },
        async play(_path: string, options?: PlaybackOptions): Promise<void> {
            options?.onStarted?.();
            playbackStarted();
            return await new Promise<void>(resolve => {
                finishPlayback = resolve;
            });
        },
        stopPlayback(): void {
            flushes += 1;
        },
    };
    const queue = new SpeechQueue(fakeTts as unknown as TextToSpeechService);

    try {
        queue.enqueue("Áudio que será interrompido.");
        await started;
        await queue.interrupt();
        await access(audioPath);
        assert.equal(queue.isSpeaking(), true);

        // Simula playback_cancelled vindo do processo persistente.
        finishPlayback?.();
        await queue.waitUntilIdle();
        assert.equal(flushes, 1);
        assert.equal(queue.isSpeaking(), false);
        await assert.rejects(
            () => access(audioPath),
            (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
    } finally {
        finishPlayback?.();
        await rm(root, { recursive: true, force: true });
    }
});

test("erro terminal libera o WAV somente depois de chegar à SpeechQueue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-persistent-player-"));
    const audioPath = path.join(root, "audio.wav");
    await writeFile(audioPath, Buffer.from("RIFF"));
    let rejectPlayback: ((error: Error) => void) | undefined;
    let playbackErrors = 0;
    let playEntered!: () => void;
    const entered = new Promise<void>(resolve => { playEntered = resolve; });
    const fakeTts = {
        async synthesize(): Promise<string> {
            return audioPath;
        },
        async play(_path: string, options?: PlaybackOptions): Promise<void> {
            options?.onStarted?.();
            playEntered();
            await new Promise<void>((_resolve, reject) => {
                rejectPlayback = reject;
            });
        },
        stopPlayback(): void {},
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
        { onPlaybackError: () => { playbackErrors += 1; } },
    );

    try {
        queue.enqueue("Falha terminal.");
        await entered;
        await access(audioPath);
        rejectPlayback?.(new Error("player falhou"));
        await queue.waitUntilIdle();
        assert.equal(playbackErrors, 1);
        await assert.rejects(
            () => access(audioPath),
            (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
    } finally {
        rejectPlayback?.(new Error("fim do teste"));
        await rm(root, { recursive: true, force: true });
    }
});

test("negociação de capability mantém fallback para serviço legado", () => {
    assert.equal(supportsPersistentPlayback(["synthesis-v1", "playback-v1"]), true);
    assert.equal(supportsPersistentPlayback(["synthesis-v1"]), false);
    assert.equal(supportsPersistentPlayback(undefined), false);
    assert.equal(supportsPersistentPlayback({ playback: true }), false);
    assert.equal(supportsPersistentPlayback("playback-v1"), false);
});
