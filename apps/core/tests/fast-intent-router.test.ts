import assert from "node:assert/strict";
import test from "node:test";

import { parseDirectAutomationCommand } from "../src/ai/ollama.service.ts";
import {
    extractTelevisionPairingCode,
    FastIntentRouter,
} from "../src/intent/fast-intent-router.ts";
import { ApplicationResolver } from "../src/system/application-resolver.ts";
import { ultronToolRegistry } from "../src/tools/core-tool-registry.ts";

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

test("cancela confirmação sensível pendente por conversa sem executar provider", async () => {
    const conversationId = `fast-confirmation-${Date.now()}`;
    await ultronToolRegistry.execute("mail.send", {
        to: ["destinatario@example.test"],
        subject: "Assunto",
        text: "Mensagem",
    }, { conversationId });
    const router = new FastIntentRouter(parseDirectAutomationCommand);

    const result = await router.execute("não", { conversationId });

    assert.equal(result?.handled, true);
    assert.equal(result?.response, "Certo, ação cancelada.");
    assert.equal(ultronToolRegistry.pendingConfirmation(conversationId), null);
});

test("planeja Gmail, Tasks e Calendar localmente sem acessar providers", () => {
    const router = new FastIntentRouter(parseDirectAutomationCommand);

    assert.equal(router.planActions("Leia meus emails novos")[0]?.name, "mail.list");
    const task = router.planActions("Crie uma tarefa para revisar o contrato amanhã")[0];
    assert.equal(task?.name, "task.create");
    assert.match(String(task?.input.due), /^\d{4}-\d{2}-\d{2}T/);
    const event = router.planActions("Marque uma reunião com João amanhã às 15h")[0];
    assert.equal(event?.name, "calendar.create");
    assert.equal(event?.input.checkConflicts, true);
});

test("mantém ordem contextual em email seguido de tarefa", () => {
    const router = new FastIntentRouter(parseDirectAutomationCommand);
    const actions = router.planActions(
        "Procure o email que fala do processo seletivo e crie uma tarefa para responder esse email amanhã",
    );

    assert.deepEqual(actions.map(action => action.name), ["mail.search", "task.create"]);
    assert.equal(actions[0]?.serialKey, "personal-context");
    assert.equal(actions[1]?.serialKey, "personal-context");
    assert.equal(actions[1]?.input.useActiveEmail, true);
});

test("não executa a metade reconhecida de um pedido composto ambíguo", () => {
    const router = new FastIntentRouter(parseDirectAutomationCommand);
    assert.deepEqual(router.planActions("Abra o Spotify e me diga uma piada"), []);
    assert.deepEqual(router.planActions("Ligue a luz e toque uma música"), []);
    assert.equal(parseDirectAutomationCommand("Ligue a luz e toque uma música"), null);
    assert.equal(router.planActions("Abra o Spotify")[0]?.name, "open_application");
});

test("falha contextual bloqueia a ação seguinte sem bloquear ramo independente", async t => {
    const calls: string[] = [];
    t.mock.method(ultronToolRegistry, "execute", async (name: string) => {
        calls.push(name);
        if (name === "mail.search") {
            return { success: false, status: "failed" as const, message: "Email indisponível." };
        }
        return { success: true, status: "confirmed" as const, message: "ok" };
    });
    const router = new FastIntentRouter(parseDirectAutomationCommand);
    const result = await router.execute(
        "Procure o email do processo seletivo e crie uma tarefa para responder esse email amanhã e ligue a luz",
        { conversationId: "planner-fast" },
    );
    assert.deepEqual(calls.sort(), ["control_light", "mail.search"]);
    assert.deepEqual(result?.actions.map(action => action.name), [
        "mail.search", "task.create", "control_light",
    ]);
    assert.equal(result?.results[1]?.error?.code, "PLAN_DEPENDENCY_BLOCKED");
    assert.equal(result?.results[2]?.success, true);
});
