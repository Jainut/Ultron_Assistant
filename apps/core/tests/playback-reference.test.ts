import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { PlaybackReference } from "../src/speech/playback-reference.ts";
import { SpeechQueue } from "../src/speech/speech-queue.ts";
import { SpeechToTextService } from "../src/speech/speech-to-text.ts";
import type {
    PlaybackOptions,
    TextToSpeechService,
} from "../src/speech/text-to-speech.ts";

test("referência de playback respeita confirmação, terminal e vida do WAV", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-playback-ref-"));
    const audioPath = path.join(root, "chunk.wav");
    await writeFile(audioPath, Buffer.from("RIFF"));

    const events: string[] = [];
    let announceStarted: (() => void) | undefined;
    let finishPlayback: (() => void) | undefined;
    let playEntered!: () => void;
    const entered = new Promise<void>(resolve => { playEntered = resolve; });
    const fakeTts = {
        async synthesize(): Promise<string> {
            return audioPath;
        },
        async play(_candidate: string, options?: PlaybackOptions): Promise<void> {
            announceStarted = options?.onStarted;
            playEntered();
            await new Promise<void>(resolve => { finishPlayback = resolve; });
        },
        stopPlayback(): void {},
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
        {
            onFirstPlayback: () => events.push("first"),
            onPlaybackChunkStart(reference) {
                assert.equal(reference.path, audioPath);
                assert.equal(reference.generation, 0);
                assert.ok(reference.startedAtUnixMs <= Date.now());
                assert.equal(existsSync(reference.path), true);
                events.push("chunk-start");
            },
            onPlaybackChunkEnd(reference) {
                assert.equal(existsSync(reference.path), true);
                events.push("chunk-end");
            },
            onPlaybackEnd: () => events.push("all-end"),
        },
    );

    try {
        queue.enqueue("Primeiro trecho.");
        await entered;
        assert.deepEqual(events, []);
        assert.equal(existsSync(audioPath), true);

        announceStarted?.();
        assert.deepEqual(events, ["first", "chunk-start"]);

        finishPlayback?.();
        await queue.waitUntilIdle();
        assert.deepEqual(events, ["first", "chunk-start", "chunk-end", "all-end"]);
        assert.equal(existsSync(audioPath), false);
    } finally {
        finishPlayback?.();
        await rm(root, { recursive: true, force: true });
    }
});

test("cada chunk recebe referência terminal com a mesma geração", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-playback-ref-"));
    const paths = [path.join(root, "one.wav"), path.join(root, "two.wav")];
    await Promise.all(paths.map(candidate => writeFile(candidate, Buffer.from("RIFF"))));

    let synthesis = 0;
    const events: Array<{ event: "start" | "end"; reference: PlaybackReference }> = [];
    const fakeTts = {
        async synthesize(): Promise<string> {
            return paths[synthesis++]!;
        },
        async play(_candidate: string, options?: PlaybackOptions): Promise<void> {
            options?.onStarted?.();
        },
        stopPlayback(): void {},
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
        {
            onPlaybackChunkStart: reference => events.push({ event: "start", reference }),
            onPlaybackChunkEnd: reference => events.push({ event: "end", reference }),
        },
    );

    try {
        queue.enqueue("Um.");
        queue.enqueue("Dois.");
        await queue.waitUntilIdle();

        assert.deepEqual(events.map(item => [item.event, item.reference.path]), [
            ["start", paths[0]],
            ["end", paths[0]],
            ["start", paths[1]],
            ["end", paths[1]],
        ]);
        assert.deepEqual(events.map(item => item.reference.generation), [0, 0, 0, 0]);
        assert.equal(events[0]!.reference, events[1]!.reference);
        assert.equal(events[2]!.reference, events[3]!.reference);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("interrupt encerra referência antiga antes de iniciar a nova geração", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-playback-ref-"));
    const paths = [path.join(root, "old.wav"), path.join(root, "new.wav")];
    await Promise.all(paths.map(candidate => writeFile(candidate, Buffer.from("RIFF"))));

    let synthesis = 0;
    let activeTerminal: (() => void) | undefined;
    let firstStarted!: () => void;
    const firstStart = new Promise<void>(resolve => { firstStarted = resolve; });
    const events: string[] = [];
    const fakeTts = {
        async synthesize(): Promise<string> {
            return paths[synthesis++]!;
        },
        async play(candidate: string, options?: PlaybackOptions): Promise<void> {
            options?.onStarted?.();
            if (candidate === paths[0]) {
                firstStarted();
                await new Promise<void>(resolve => { activeTerminal = resolve; });
            }
        },
        stopPlayback(): void {
            activeTerminal?.();
        },
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
        {
            onPlaybackChunkStart: reference => {
                events.push(`start:${reference.generation}`);
            },
            onPlaybackChunkEnd: reference => {
                events.push(`end:${reference.generation}`);
            },
        },
    );

    try {
        queue.enqueue("Resposta antiga.");
        await firstStart;
        await queue.interrupt();
        queue.enqueue("Resposta nova.");
        await queue.waitUntilIdle();

        assert.deepEqual(events, ["start:0", "end:0", "start:1", "end:1"]);
    } finally {
        activeTerminal?.();
        await rm(root, { recursive: true, force: true });
    }
});

test("playback_started atrasado de geração cancelada não publica referência", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-playback-ref-"));
    const audioPath = path.join(root, "stale.wav");
    await writeFile(audioPath, Buffer.from("RIFF"));

    let announceStarted: (() => void) | undefined;
    let finishPlayback: (() => void) | undefined;
    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    const references: PlaybackReference[] = [];
    let flushes = 0;
    const fakeTts = {
        async synthesize(): Promise<string> {
            return audioPath;
        },
        async play(_candidate: string, options?: PlaybackOptions): Promise<void> {
            announceStarted = options?.onStarted;
            enteredResolve();
            await new Promise<void>(resolve => { finishPlayback = resolve; });
        },
        stopPlayback(): void {
            flushes += 1;
        },
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
        { onPlaybackChunkStart: reference => references.push(reference) },
    );

    try {
        queue.enqueue("Resposta cancelada.");
        await entered;
        await queue.interrupt();
        announceStarted?.();
        finishPlayback?.();
        await queue.waitUntilIdle();

        assert.deepEqual(references, []);
        assert.equal(flushes, 2);
    } finally {
        finishPlayback?.();
        await rm(root, { recursive: true, force: true });
    }
});

test("falha de listener de referência não derruba playback nem limpeza", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-playback-ref-"));
    const audioPath = path.join(root, "listener-error.wav");
    await writeFile(audioPath, Buffer.from("RIFF"));
    let completed = 0;
    const fakeTts = {
        async synthesize(): Promise<string> {
            return audioPath;
        },
        async play(_candidate: string, options?: PlaybackOptions): Promise<void> {
            options?.onStarted?.();
        },
        stopPlayback(): void {},
    };
    const queue = new SpeechQueue(
        fakeTts as unknown as TextToSpeechService,
        {
            onPlaybackChunkStart() {
                throw new Error("listener start indisponível");
            },
            onPlaybackChunkEnd() {
                throw new Error("listener end indisponível");
            },
            onPlaybackEnd() {
                completed += 1;
            },
        },
    );

    try {
        queue.enqueue("Playback tolerante.");
        await queue.waitUntilIdle();
        assert.equal(completed, 1);
        assert.equal(existsSync(audioPath), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("STT preserva playback ativo e envia controles de referência tipados", () => {
    const lines: string[] = [];
    const stt = new SpeechToTextService();
    const writableCapture = stt as unknown as {
        captureProcess: {
            killed: boolean;
            stdin: { write(value: string): void };
        };
    };
    writableCapture.captureProcess = {
        killed: false,
        stdin: { write: value => { lines.push(value); } },
    };
    const reference: PlaybackReference = {
        path: "C:\\audio\\speech.wav",
        generation: 7,
        startedAtUnixMs: 1_777_000_000_000,
    };

    stt.setPlaybackActive(true);
    stt.startPlaybackReference(reference);
    stt.endPlaybackReference(reference);
    stt.setPlaybackActive(false);

    assert.deepEqual(lines.map(line => JSON.parse(line) as unknown), [
        { type: "playback", active: true },
        { type: "playback_reference_start", ...reference },
        { type: "playback_reference_end", ...reference },
        { type: "playback", active: false },
    ]);
});
