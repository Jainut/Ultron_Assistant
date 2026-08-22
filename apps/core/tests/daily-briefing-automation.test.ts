import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AutomationEngine } from "../src/automation-engine/automation-engine.ts";
import { createDailyBriefingAutomationTool } from "../src/personal-automation/daily-briefing-automation.tool.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

test("agenda daily briefing de forma persistente e idempotente", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-daily-automation-"));
    try {
        const engine = new AutomationEngine({
            storageDirectory: directory,
            defaultTimezone: "America/Sao_Paulo",
            pollIntervalMs: 25,
        });
        const registry = new ToolRegistry().register(
            createDailyBriefingAutomationTool(engine),
        );
        const input = {
            time: "08:00",
            timeZone: "America/Sao_Paulo",
            daysOfWeek: [1, 2, 3, 4, 5],
        };

        const first = await registry.execute("automation.createDailyBriefing", input);
        const second = await registry.execute("automation.createDailyBriefing", input);

        assert.equal(first.success, true);
        assert.equal((first.data as { created: boolean }).created, true);
        assert.equal((second.data as { created: boolean }).created, false);
        const automations = await engine.listAutomations();
        assert.equal(automations.length, 1);
        assert.equal(automations[0]?.actions[0]?.type, "personal.dailyBriefing");
        assert.equal((await engine.jobs.list()).length, 1);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("criação concorrente não duplica e parâmetros operacionais diferentes não colidem", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-daily-automation-race-"));
    try {
        const engine = new AutomationEngine({
            storageDirectory: directory,
            defaultTimezone: "America/Sao_Paulo",
            pollIntervalMs: 25,
        });
        const tool = createDailyBriefingAutomationTool(engine);
        const input = {
            time: "08:00",
            timeZone: "America/Sao_Paulo",
            daysOfWeek: [5, 1, 3, 2, 4],
            maxEmails: 10,
        };

        const concurrent = await Promise.all([
            tool.execute(input, {}),
            tool.execute({ ...input, daysOfWeek: [1, 2, 3, 4, 5] }, {}),
        ]);
        assert.deepEqual(
            concurrent.map(result => result.data?.created).sort(),
            [false, true],
        );

        const weekend = await tool.execute({
            ...input,
            daysOfWeek: [0, 6],
        }, {});
        const moreEmails = await tool.execute({
            ...input,
            maxEmails: 25,
        }, {});
        assert.equal(weekend.data?.created, true);
        assert.equal(moreEmails.data?.created, true);
        assert.equal((await engine.listAutomations()).length, 3);
        assert.equal((await engine.jobs.list()).length, 3);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
