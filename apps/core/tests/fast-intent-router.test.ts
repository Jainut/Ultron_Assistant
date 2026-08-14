import assert from "node:assert/strict";
import test from "node:test";

import { parseDirectAutomationCommand } from "../src/ai/ollama.service.ts";
import {
    extractTelevisionPairingCode,
    FastIntentRouter,
} from "../src/intent/fast-intent-router.ts";
import { ApplicationResolver } from "../src/system/application-resolver.ts";

test("resolve aliases configurados sem esperar o scan de aplicativos", async () => {
    const resolver = new ApplicationResolver();
    const startedAt = performance.now();
    const match = await resolver.resolve("VS Code");

    assert.equal(match?.entry.source, "configured");
    assert.ok((match?.score ?? 0) >= 0.92);
    assert.ok(performance.now() - startedAt < 100);
});

test("executa horário pelo caminho rápido sem consultar a LLM", async () => {
    const router = new FastIntentRouter(parseDirectAutomationCommand);
    const result = await router.execute("Ultron, que horas são?");

    assert.equal(result?.handled, true);
    assert.equal(result?.actions[0]?.name, "get_current_time");
    assert.equal(result?.results[0]?.success, true);
});

test("entende PIN da Android TV em algarismos ou palavras", () => {
    assert.equal(extractTelevisionPairingCode("código 1 2 3 4 5 6"), "123456");
    assert.equal(extractTelevisionPairingCode("pin um dois três quatro cinco seis"), "123456");
});
