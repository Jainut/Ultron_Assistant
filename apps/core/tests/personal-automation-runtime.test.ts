import assert from "node:assert/strict";
import test from "node:test";

import {
    automationEngine,
    registerToolActions,
} from "../src/automation-engine/runtime.ts";
import { ultronToolRegistry } from "../src/tools/core-tool-registry.ts";

test("runtime registra automações pessoais no registry e engine uma única vez", () => {
    registerToolActions();
    const registeredCount = ultronToolRegistry.list().length;
    registerToolActions();

    assert.equal(ultronToolRegistry.list().length, registeredCount);
    for (const name of [
        "personal.dailyBriefing",
        "automation.createDailyBriefing",
        "automation.createEmailWatch",
        "automation.createCalendarReminder",
        "notification.list",
        "notification.markRead",
    ]) {
        assert.equal(ultronToolRegistry.has(name), true, `${name} ausente no ToolRegistry`);
    }
    for (const type of [
        "personal.dailyBriefing",
        "mail.watch",
        "calendar.reminderScan",
    ]) {
        assert.equal(automationEngine.actions.has(type), true, `${type} ausente no ActionRegistry`);
    }
});
