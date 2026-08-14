import assert from "node:assert/strict";
import test from "node:test";

import { SpeechChunker } from "../src/speech/speech_chunker.ts";

test("libera a primeira frase cedo e preserva o restante", () => {
    const chunker = new SpeechChunker(10, 40);

    assert.deepEqual(chunker.push("Esta é a primeira frase. A segunda"), [
        "Esta é a primeira frase.",
    ]);
    assert.deepEqual(chunker.flush(), ["A segunda"]);
});
