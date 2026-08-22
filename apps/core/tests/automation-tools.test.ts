import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AutomationEngine } from "../src/automation-engine/automation-engine.ts";
import { registerAutomationTools } from "../src/tools/automation/index.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

test("tools de automação criam, listam, agendam e excluem estado persistente", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-automation-tools-"));
    try {
        const engine = new AutomationEngine({ storageDirectory: temporaryRoot });
        const registry = new ToolRegistry();
        registerAutomationTools(registry, engine);

        const created = await registry.execute<{ id: string }>("automation.create", {
            name: "Teste persistente",
            trigger: { type: "system.startup", config: {} },
            actions: [{ type: "get_current_time", input: {} }],
            timezone: "America/Sao_Paulo",
        });
        assert.equal(created.status, "confirmed");
        assert.ok(created.data?.id);

        const listed = await registry.execute<{ automations: unknown[] }>("automation.list", {});
        assert.equal(listed.data?.automations.length, 1);

        const run = await registry.execute("automation.run", {
            automationId: created.data!.id,
        });
        assert.equal(run.status, "accepted");

        const blocked = await registry.execute("automation.delete", {
            automationId: created.data!.id,
        }, { conversationId: "automation-test" });
        assert.equal(blocked.status, "unknown");
        assert.ok(registry.pendingConfirmation("automation-test"));

        const removed = await registry.approvePendingConfirmation("automation-test");
        assert.equal(removed?.result.status, "confirmed");
        assert.equal((await engine.listAutomations()).length, 0);
        assert.equal((await engine.jobs.list()).length, 0);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});
