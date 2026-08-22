import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    criticalTermStats,
    inventory,
    median,
    normalizeWords,
    parseWhisperDiagnostics,
    wordErrorStats,
} from "./whisper-benchmark.mjs";

test("inventário local reporta ausências sem baixar artefatos", async context => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-whisper-bench-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "bin"), { recursive: true });
    await mkdir(path.join(root, "models"), { recursive: true });
    await mkdir(path.join(root, "samples"), { recursive: true });
    await writeFile(path.join(root, "bin", "whisper-cli.exe"), "fixture");
    await writeFile(path.join(root, "models", "small.bin"), "fixture");
    await writeFile(path.join(root, "samples", "command.wav"), "fixture");
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
        cli: "bin/whisper-cli.exe",
        models: [
            { id: "small", paths: ["models/small.bin"] },
            { id: "large-v3-turbo", paths: ["models/turbo.bin"] },
        ],
        samples: [{
            id: "command",
            audio: "samples/command.wav",
            language: "pt",
            reference: "Ultron",
            criticalTerms: ["Ultron"],
        }],
    }));

    const found = await inventory({ root, manifestPath, models: null });
    assert.equal(found.cli.available, true);
    assert.equal(found.models[0].available, true);
    assert.equal(found.models[1].available, false);
    assert.equal(found.samples[0].labeled, true);
});

test("normalização e WER ignoram caixa, acento e pontuação", () => {
    assert.deepEqual(normalizeWords("Olá, ULTRON!"), ["ola", "ultron"]);
    assert.equal(wordErrorStats("Olá Ultron", "ola, ultron!").wer, 0);
    const changed = wordErrorStats("Ultron abre o VS Code", "Ultron abra VS Code");
    assert.equal(changed.edits, 2);
    assert.equal(changed.referenceWords, 5);
    assert.equal(changed.wer, 0.4);
});

test("termos críticos suportam expressões com várias palavras", () => {
    const result = criticalTermStats(
        ["Ultron", "Visual Studio Code", "Zen Browser"],
        "Ultron, abra o Visual Studio Code.",
    );
    assert.deepEqual(result.hits, ["Ultron", "Visual Studio Code"]);
    assert.deepEqual(result.misses, ["Zen Browser"]);
    assert.equal(result.recall, 2 / 3);
});

test("parser separa load, inferência aproximada, áudio e GPU", () => {
    const diagnostics = parseWhisperDiagnostics(`
ggml_vulkan: 0 = AMD Radeon RX 6600 (AMD proprietary driver) | fp16: 1
whisper_model_load:      Vulkan0 total size = 1533.14 MB
main: processing 'sample.wav' (176000 samples, 11.0 sec), task = transcribe
whisper_print_timings:     load time = 2786.31 ms
whisper_print_timings:   encode time = 3973.92 ms
whisper_print_timings:    total time = 9838.99 ms
    `);
    assert.equal(diagnostics.device, "AMD Radeon RX 6600 (AMD proprietary driver)");
    assert.equal(diagnostics.modelGpuMiB, 1533.14);
    assert.equal(diagnostics.audioDurationSeconds, 11);
    assert.equal(diagnostics.loadMs, 2786.31);
    assert.equal(diagnostics.processingExcludingLoadMs, 7052.68);
    assert.equal(median([9, 1, 5, 3]), 4);
});
