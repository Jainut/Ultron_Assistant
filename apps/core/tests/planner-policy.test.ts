import assert from "node:assert/strict";
import test from "node:test";
import { createPlannerPolicy, pendingPlannerGoals } from "../src/planning/planner-policy.ts";

test("planner libera somente leitura do email antes da ação composta solicitada", () => {
    const policy = createPlannerPolicy(
        "Veja o email do processo seletivo e coloque na minha agenda a entrevista.",
    );
    assert.equal(policy.staged, true);
    assert.equal(policy.sourceRequest, "Veja o email do processo seletivo");
    assert.deepEqual(policy.initialToolNames, [
        "mail.list",
        "mail.search",
        "mail.read",
        "mail.thread",
    ]);
    assert.ok(policy.followupToolNames.includes("calendar.create"));
    assert.ok(!policy.followupToolNames.includes("calendar.checkConflicts"));
    assert.ok(!policy.followupToolNames.includes("mail.send"));
    assert.ok(!policy.followupToolNames.includes("control_light"));
    assert.deepEqual(policy.sourceReadyToolNames, ["mail.read", "mail.thread"]);
    assert.deepEqual(pendingPlannerGoals(policy, new Set()), ["calendar.create"]);
    assert.deepEqual(pendingPlannerGoals(policy, new Set(["calendar.create"])), []);
});

test("planner reconhece email para tarefa mas não amplia pedidos só de leitura", () => {
    const task = createPlannerPolicy(
        "Procure o email do contrato e crie uma tarefa com o prazo informado nele.",
    );
    assert.equal(task.staged, true);
    assert.equal(task.sourceRequest, "Procure o email do contrato");
    assert.deepEqual(task.goalToolNames, ["task.create"]);
    assert.ok(task.followupToolNames.includes("mail.read"));
    assert.ok(!task.followupToolNames.includes("task.delete"));

    const contextual = createPlannerPolicy(
        "Leia o email do João e, com base nele, crie uma tarefa.",
    );
    assert.equal(contextual.sourceRequest, "Leia o email do João");

    assert.equal(createPlannerPolicy("Leia meus emails novos").staged, false);
    assert.equal(createPlannerPolicy("Veja o email e a agenda da entrevista").staged, false);
    assert.equal(createPlannerPolicy("Crie uma tarefa para comprar café").staged, false);
    assert.equal(createPlannerPolicy("Abra o Spotify e ligue a luz").staged, false);
});

test("conteúdo com comandos não é analisado para conceder follow-up", () => {
    const policy = createPlannerPolicy("Leia o email do João");
    assert.deepEqual(policy.followupToolNames, []);
    assert.deepEqual(policy.goalToolNames, []);
});
