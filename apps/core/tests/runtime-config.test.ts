import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { selectDefaultWhisperModel } from "../src/config/runtime.ts";

async function addModel(root: string, model: string): Promise<void> {
    const directory = path.join(root, "services", "speech-whisper");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, model), "fixture");
}

test("seleção automática prefere Turbo Q5 quando ele está instalado", async context => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-model-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    await addModel(root, "ggml-small.bin");
    await addModel(root, "ggml-medium.bin");
    await addModel(root, "ggml-large-v3-turbo-q5_0.bin");

    assert.equal(
        selectDefaultWhisperModel(root),
        "ggml-large-v3-turbo-q5_0.bin",
    );
});

test("seleção automática preserva medium e small como fallbacks", async context => {
    const mediumRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-model-"));
    const smallRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-model-"));
    context.after(() => Promise.all([
        rm(mediumRoot, { recursive: true, force: true }),
        rm(smallRoot, { recursive: true, force: true }),
    ]));
    await addModel(mediumRoot, "ggml-medium.bin");
    await addModel(smallRoot, "ggml-small.bin");

    assert.equal(selectDefaultWhisperModel(mediumRoot), "ggml-medium.bin");
    assert.equal(selectDefaultWhisperModel(smallRoot), "ggml-small.bin");
});
