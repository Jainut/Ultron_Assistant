import assert from "node:assert/strict";
import test from "node:test";

import { ToolRegistry } from "../src/tools/tool-registry.ts";
import type { ToolDefinition } from "../src/tools/tool.ts";
import { requestPerformanceTimelines } from "../src/utils/request-performance-timeline.ts";

function fakeTool(
    overrides: Partial<ToolDefinition<{ value: string }, { value: string }>> = {},
): ToolDefinition<{ value: string }, { value: string }> {
    return {
        name: "fake.read",
        description: "Ferramenta determinística de teste.",
        category: "information",
        inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
        },
        aliases: ["fake"],
        capabilities: ["fake.read"],
        confirmationLevel: "none",
        executionMode: "sync",
        successStatus: "confirmed",
        responsePolicy: { deterministic: true },
        execute: async input => ({
            success: true,
            message: input.value,
            data: input,
        }),
        ...overrides,
    };
}

test("ToolRegistry centraliza aliases, schema, capabilities e ActionStatus", async () => {
    const registry = new ToolRegistry().register(fakeTool());

    assert.equal(registry.has("fake"), true);
    assert.deepEqual(registry.list()[0]?.capabilities, ["fake.read"]);
    assert.equal(registry.modelSchemas({ names: ["fake.read"] })[0]?.function.name, "fake.read");

    const result = await registry.execute<{ value: string }>("fake", { value: "ok" });
    assert.equal(result.success, true);
    assert.equal(result.status, "confirmed");
    assert.equal(result.data?.value, "ok");
});

test("ToolRegistry preserva accepted e optimistic sem promovê-los a confirmed", async () => {
    const acceptedRegistry = new ToolRegistry().register(fakeTool({
        name: "fake.accepted",
        aliases: [],
        successStatus: "accepted",
    }));
    const optimisticRegistry = new ToolRegistry().register(fakeTool({
        name: "fake.optimistic",
        aliases: [],
        successStatus: "optimistic",
    }));

    assert.equal(
        (await acceptedRegistry.execute("fake.accepted", { value: "x" })).status,
        "accepted",
    );
    assert.equal(
        (await optimisticRegistry.execute("fake.optimistic", { value: "x" })).status,
        "optimistic",
    );
});

test("ToolRegistry não transforma falha em ação aceita", async () => {
    const registry = new ToolRegistry().register(fakeTool({
        name: "fake.failure",
        aliases: [],
        successStatus: "accepted",
        execute: async () => ({ success: false, message: "falhou" }),
    }));

    const result = await registry.execute("fake.failure", { value: "x" });
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
});

test("ToolRegistry valida a entrada antes de chegar à implementação", async () => {
    let executed = false;
    const registry = new ToolRegistry().register(fakeTool({
        execute: async input => {
            executed = true;
            return { success: true, message: "ok", data: input };
        },
    }));

    const result = await registry.execute("fake.read", { value: 42, extra: true });
    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "TOOL_INPUT_INVALID");
    assert.equal(executed, false);
});

test("validação cobre arrays mínimos e alternativas nullable usadas pelos providers", async () => {
    const registry = new ToolRegistry().register(fakeTool({
        name: "fake.compose",
        aliases: [],
        inputSchema: {
            type: "object",
            properties: {
                recipients: { type: "array", items: { type: "string" }, minItems: 1 },
                note: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["recipients"],
            additionalProperties: false,
        },
    }));

    assert.equal(
        (await registry.execute("fake.compose", { recipients: [], note: null })).error?.code,
        "TOOL_INPUT_INVALID",
    );
    assert.equal(
        (await registry.execute("fake.compose", { recipients: ["a@b.test"], note: null })).success,
        true,
    );
});

test("confirmation policy rejeita aprovação forjada e só aceita o ID pendente", async () => {
    let executions = 0;
    const registry = new ToolRegistry().register(fakeTool({
        name: "mail.send",
        aliases: [],
        category: "mail",
        capabilities: ["mail.send"],
        confirmationLevel: "confirm-before-execute",
        execute: async input => {
            executions += 1;
            return { success: true, message: "enviado", data: input };
        },
    }));

    const blocked = await registry.execute(
        "mail.send",
        { value: "rascunho" },
        { conversationId: "conversation-secure" },
    );
    assert.equal(blocked.success, false);
    assert.equal(blocked.status, "unknown");
    assert.equal(executions, 0);

    const forged = await registry.execute(
        "mail.send",
        { value: "rascunho" },
        {
            conversationId: "conversation-secure",
            confirmation: {
                approved: true,
                capability: "mail.send",
                confirmationId: "forged-confirmation-id",
            },
        },
    );
    assert.equal(forged.success, false);
    assert.equal(forged.status, "unknown");
    assert.equal(forged.error?.code, "CONFIRMATION_INVALID");
    assert.equal(executions, 0);

    const approved = await registry.approvePendingConfirmation("conversation-secure");
    assert.equal(approved?.result.success, true);
    assert.equal(approved?.result.status, "confirmed");
    assert.equal(executions, 1);
});

test("confirmação pendente fica isolada por conversa e só então repete a ação", async () => {
    let executions = 0;
    const registry = new ToolRegistry().register(fakeTool({
        name: "mail.send",
        aliases: [],
        category: "mail",
        capabilities: ["mail.send"],
        confirmationLevel: "confirm-before-execute",
        execute: async input => {
            executions += 1;
            return { success: true, status: "accepted", message: "aceito", data: input };
        },
    }));

    const blocked = await registry.execute(
        "mail.send",
        { value: "mensagem" },
        { conversationId: "conversation-a" },
    );
    assert.equal(executions, 0);
    assert.equal(typeof (blocked.data as { confirmationId?: unknown })?.confirmationId, "string");
    assert.equal(registry.pendingConfirmation("conversation-b"), null);

    const approved = await registry.approvePendingConfirmation("conversation-a");
    assert.equal(approved?.name, "mail.send");
    assert.equal(approved?.result.status, "accepted");
    assert.equal(executions, 1);
    assert.equal(registry.pendingConfirmation("conversation-a"), null);
});

test("múltiplas confirmações da mesma conversa ficam em fila sem sobrescrever", async () => {
    const executions: string[] = [];
    const registry = new ToolRegistry()
        .register(fakeTool({
            name: "mail.send",
            aliases: [],
            category: "mail",
            capabilities: ["mail.send"],
            confirmationLevel: "confirm-before-execute",
            execute: async input => {
                executions.push(`mail:${input.value}`);
                return { success: true, status: "accepted", message: "aceito", data: input };
            },
        }))
        .register(fakeTool({
            name: "task.delete",
            aliases: [],
            category: "tasks",
            capabilities: ["task.delete"],
            confirmationLevel: "dangerous",
            execute: async input => {
                executions.push(`task:${input.value}`);
                return { success: true, status: "confirmed", message: "excluída", data: input };
            },
        }));

    await Promise.all([
        registry.execute(
            "mail.send",
            { value: "mensagem" },
            { conversationId: "conversation-multi" },
        ),
        registry.execute(
            "task.delete",
            { value: "task-1" },
            { conversationId: "conversation-multi" },
        ),
    ]);

    const pending = registry.pendingConfirmationsForConversation("conversation-multi");
    assert.equal(pending.length, 2);
    assert.notEqual(pending[0]?.confirmationId, pending[1]?.confirmationId);
    assert.deepEqual(executions, []);

    const first = await registry.approvePendingConfirmation("conversation-multi");
    assert.equal(first?.name, "mail.send");
    assert.equal(first?.remainingConfirmations, 1);
    assert.deepEqual(executions, ["mail:mensagem"]);

    const secondId = pending[1]!.confirmationId;
    const second = await registry.approvePendingConfirmation(
        "conversation-multi",
        {},
        secondId,
    );
    assert.equal(second?.name, "task.delete");
    assert.equal(second?.remainingConfirmations, 0);
    assert.deepEqual(executions, ["mail:mensagem", "task:task-1"]);
    assert.equal(registry.pendingConfirmation("conversation-multi"), null);
});

test("confirmationId em voo não pode ser reutilizado com outra entrada", async () => {
    let releaseExecution!: () => void;
    let markStarted!: () => void;
    const executionStarted = new Promise<void>(resolve => {
        markStarted = resolve;
    });
    const executionReleased = new Promise<void>(resolve => {
        releaseExecution = resolve;
    });
    let executions = 0;
    const registry = new ToolRegistry().register(fakeTool({
        name: "mail.send",
        aliases: [],
        category: "mail",
        capabilities: ["mail.send"],
        confirmationLevel: "confirm-before-execute",
        execute: async input => {
            executions += 1;
            markStarted();
            await executionReleased;
            return { success: true, status: "accepted", message: "aceito", data: input };
        },
    }));

    await registry.execute(
        "mail.send",
        { value: "original" },
        { conversationId: "conversation-input-binding" },
    );
    const pending = registry.pendingConfirmation("conversation-input-binding");
    assert.ok(pending);

    const approval = registry.approvePendingConfirmation("conversation-input-binding");
    await executionStarted;
    const replayPromise = registry.execute(
        "mail.send",
        { value: "alterado" },
        {
            conversationId: "conversation-input-binding",
            confirmation: {
                approved: true,
                capability: pending.capability,
                confirmationId: pending.confirmationId,
            },
        },
    );

    releaseExecution();
    const [replay, approved] = await Promise.all([replayPromise, approval]);
    assert.equal(replay.success, false);
    assert.equal(replay.error?.code, "CONFIRMATION_INVALID");
    assert.equal(executions, 1);
    assert.equal(approved?.result.status, "accepted");
});

test("usuário pode recusar uma ação pendente sem executá-la", async () => {
    let executions = 0;
    const registry = new ToolRegistry().register(fakeTool({
        name: "task.delete",
        aliases: [],
        category: "tasks",
        capabilities: ["task.delete"],
        confirmationLevel: "dangerous",
        execute: async input => {
            executions += 1;
            return { success: true, message: "apagada", data: input };
        },
    }));
    await registry.execute(
        "task.delete",
        { value: "task-1" },
        { conversationId: "conversation-c" },
    );

    const cancelled = registry.cancelPendingConfirmation("conversation-c");
    assert.equal(cancelled?.result.status, "confirmed");
    assert.equal(executions, 0);
});

test("capability policy pode restringir uma tool sem alterar seu código", async () => {
    let executions = 0;
    const registry = new ToolRegistry().register(fakeTool({
        execute: async input => {
            executions += 1;
            return { success: true, message: "ok", data: input };
        },
    }));

    const result = await registry.execute(
        "fake.read",
        { value: "x" },
        { capabilityGrant: { allowed: ["information.time.read"] } },
    );

    assert.equal(result.success, false);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "CAPABILITY_DENIED");
    assert.equal(executions, 0);
});

test("AbortSignal interrompe antes de executar a tool", async () => {
    let executed = false;
    const registry = new ToolRegistry().register(fakeTool({
        execute: async input => {
            executed = true;
            return { success: true, message: "ok", data: input };
        },
    }));
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        registry.execute("fake.read", { value: "x" }, { signal: controller.signal }),
        error => error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(executed, false);
});

test("ToolRegistry marca execução na timeline correlacionada", async () => {
    const requestId = `tool-registry-${Date.now()}`;
    requestPerformanceTimelines.start({ requestId, conversationId: "conversation-test" });
    const registry = new ToolRegistry().register(fakeTool());

    await registry.execute(
        "fake.read",
        { value: "ok" },
        { requestId, conversationId: "conversation-test", toolCallId: "tool-call-1" },
    );

    const snapshot = requestPerformanceTimelines.finish(requestId);
    const metric = snapshot?.metrics.find(item => item.name === "tool_duration");
    assert.ok(metric);
    assert.equal(metric.toolCallId, "tool-call-1");
    assert.ok(metric.valueMs >= 0);
});
