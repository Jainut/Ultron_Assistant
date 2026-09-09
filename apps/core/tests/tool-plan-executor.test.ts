import assert from "node:assert/strict";
import test from "node:test";
import { executeToolPlan, planSerialDependencies } from "../src/planning/tool-plan-executor.ts";

test("plano executa ramos independentes em paralelo e preserva dependência contextual", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started: string[] = [];
    const steps = planSerialDependencies([
        { name: "mail.search", input: {}, serialKey: "personal" },
        { name: "task.create", input: {}, serialKey: "personal" },
        { name: "control_light", input: {}, serialKey: "light" },
    ]);
    const pending = executeToolPlan(steps, async (step) => {
        started.push(step.name);
        if (step.name === "mail.search") await released;
        return { success: true, status: "confirmed", message: "ok" };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.sort(), ["control_light", "mail.search"]);
    release();
    const result = await pending;
    assert.equal(result[1]?.state, "executed");
    assert.equal(started.at(-1), "task.create");
});

test("falha ou confirmação pendente bloqueia somente descendentes", async () => {
    const called: string[] = [];
    const steps = planSerialDependencies([
        { name: "mail.search", input: {}, serialKey: "personal" },
        { name: "task.create", input: {}, serialKey: "personal" },
        { name: "control_light", input: {}, serialKey: "light" },
    ]);
    const result = await executeToolPlan(steps, async (step) => {
        called.push(step.name);
        return step.name === "mail.search"
            ? {
                  success: false,
                  status: "unknown",
                  message: "Confirme.",
                  data: { confirmationRequired: true },
              }
            : { success: true, status: "optimistic", message: "aceito" };
    });
    assert.deepEqual(called.sort(), ["control_light", "mail.search"]);
    assert.equal(result[1]?.state, "blocked");
    assert.equal(result[1]?.result.error?.code, "PLAN_DEPENDENCY_BLOCKED");
    assert.equal(result[2]?.result.status, "optimistic");
});

test("resultado otimista bem-sucedido não bloqueia o próximo comando serializado", async () => {
    const steps = planSerialDependencies([
        { name: "control_light", input: { action: "on" }, serialKey: "light" },
        { name: "control_light", input: { action: "brightness" }, serialKey: "light" },
    ]);
    const result = await executeToolPlan(steps, async (step) => ({
        success: true,
        status: step.input.action === "on" ? "optimistic" : "confirmed",
        message: "ok",
    }));
    assert.deepEqual(
        result.map((item) => item.state),
        ["executed", "executed"],
    );
});

test("plano recusa ciclos implícitos, dependência futura, IDs duplicados e excesso", async () => {
    const execute = async () => ({ success: true, message: "ok" });
    await assert.rejects(
        executeToolPlan(
            [
                { id: "a", name: "one", input: {}, dependsOn: ["b"] },
                { id: "b", name: "two", input: {} },
            ],
            execute,
        ),
        /etapas anteriores/,
    );
    await assert.rejects(
        executeToolPlan(
            [
                { id: "a", name: "one", input: {} },
                { id: "a", name: "two", input: {} },
            ],
            execute,
        ),
        /inválido ou duplicado/,
    );
    await assert.rejects(
        executeToolPlan(
            Array.from({ length: 13 }, (_, index) => ({
                id: `s-${index}`,
                name: "tool",
                input: {},
            })),
            execute,
        ),
        /no máximo 12/,
    );
});

test("cancelamento impede etapas que ainda não começaram", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const steps = planSerialDependencies([
        { name: "one", input: {}, serialKey: "same" },
        { name: "two", input: {}, serialKey: "same" },
    ]);
    const called: string[] = [];
    const pending = executeToolPlan(
        steps,
        async (step) => {
            called.push(step.name);
            if (step.name === "one") await released;
            return { success: true, message: "ok" };
        },
        controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    release();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(called, ["one"]);
});

test("benchmark do kernel: plano curto sem I/O", async (t) => {
    const actions = [
        { name: "mail.search", input: {}, serialKey: "personal" },
        { name: "mail.read", input: {}, serialKey: "personal" },
        { name: "task.create", input: {}, serialKey: "personal" },
        { name: "control_light", input: {}, serialKey: "light" },
    ];
    const iterations = 500;
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
        const steps = planSerialDependencies(actions);
        await executeToolPlan(steps, async () => ({
            success: true,
            status: "confirmed",
            message: "ok",
        }));
    }
    const average = (performance.now() - started) / iterations;
    t.diagnostic(
        `planner kernel: ${iterations} planos de 4 etapas, média=${average.toFixed(3)}ms/plano (sem I/O)`,
    );
});
