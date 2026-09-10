import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AutomationEngine } from "../src/automation-engine/automation-engine.ts";
import type { JsonObject } from "../src/automation-engine/types.ts";
import { createStartupBriefingAutomationTool } from "../src/personal-automation/startup-briefing-automation.tool.ts";

test("automação de inicialização persiste, dispara uma vez e repassa apenas as fontes escolhidas", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-startup-briefing-"));
    try {
        const received: JsonObject[] = [];
        const engine = new AutomationEngine({
            storageDirectory: directory,
            defaultTimezone: "America/Sao_Paulo",
            pollIntervalMs: 25,
        });
        engine.actions.register<JsonObject, JsonObject>(
            "personal.dailyBriefing",
            input => {
                received.push(structuredClone(input));
                return { published: true };
            },
        );
        const tool = createStartupBriefingAutomationTool(engine);

        const result = await tool.execute({
            delaySeconds: 0,
            sources: ["mail"],
            maxEmails: 12,
        }, {});

        assert.equal(result.success, true);
        assert.equal(result.data?.created, true);
        assert.equal((await engine.jobs.list()).length, 0);
        assert.deepEqual(result.data?.automation.trigger, {
            type: "system.startup",
            config: { delayMs: 0 },
        });

        await engine.start();
        await engine.stop();

        assert.deepEqual(received, [{
            timeZone: "America/Sao_Paulo",
            sources: ["mail"],
            publishNotification: true,
            maxEmails: 12,
        }]);
        const jobs = await engine.jobs.list();
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.status, "completed");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("criação concorrente é idempotente e normaliza a ordem das fontes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-startup-race-"));
    try {
        const engine = new AutomationEngine({ storageDirectory: directory });
        const tool = createStartupBriefingAutomationTool(engine);

        const results = await Promise.all([
            tool.execute({ sources: ["mail", "tasks"] }, {}),
            tool.execute({ sources: ["tasks", "mail"] }, {}),
        ]);

        assert.deepEqual(
            results.map(result => result.data?.created).sort(),
            [false, true],
        );
        const automations = await engine.listAutomations();
        assert.equal(automations.length, 1);
        assert.deepEqual(automations[0]?.actions[0]?.input, {
            timeZone: "America/Sao_Paulo",
            sources: ["tasks", "mail"],
            publishNotification: true,
            maxEmails: 20,
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("não cria automação sem provider e valida parâmetros localmente", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-startup-validation-"));
    try {
        const engine = new AutomationEngine({ storageDirectory: directory });
        const unavailable = createStartupBriefingAutomationTool(
            engine,
            "America/Sao_Paulo",
            { available: false, message: "Configure o provider primeiro." },
        );
        const failed = await unavailable.execute({}, {});
        assert.equal(failed.success, false);
        assert.equal(failed.error?.code, "PROVIDER_NOT_CONFIGURED");
        assert.equal((await engine.listAutomations()).length, 0);

        const available = createStartupBriefingAutomationTool(engine);
        await assert.rejects(
            available.execute({ delaySeconds: 301 }, {}),
            RangeError,
        );
        await assert.rejects(
            available.execute({ timeZone: "timezone-inexistente" }, {}),
            RangeError,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
