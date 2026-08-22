import path from "node:path";

import { runtimeConfig } from "../config/runtime.ts";
import {
    personalProviderRuntime,
    ultronToolRegistry,
} from "../tools/core-tool-registry.ts";
import { registerAutomationTools } from "../tools/automation/index.ts";
import { debugLog } from "../utils/debug.ts";
import { notificationCenter } from "../notifications/runtime.ts";
import {
    createDailyBriefingAutomationTool,
    createCalendarReminderAction,
    createMailWatchAction,
    createMonitorStateStore,
    registerPersonalMonitorTools,
} from "../personal-automation/index.ts";
import { AutomationEngine } from "./automation-engine.ts";
import type { JsonValue } from "./types.ts";

const defaultTimezone = process.env.ULTRON_TIMEZONE?.trim()
    || "America/Sao_Paulo";
const monitorState = createMonitorStateStore(path.join(
    runtimeConfig.projectRoot,
    "data",
    "personal-automation",
    "monitor-state.json",
));

/**
 * Runtime persistente de automações. Ele é construído sem I/O e só começa a
 * ler jobs quando startAutomationRuntime é chamado após o caminho crítico de voz.
 */
export const automationEngine = new AutomationEngine({
    storageDirectory: path.join(runtimeConfig.projectRoot, "data", "automation"),
    defaultTimezone,
    pollIntervalMs: 1_000,
    maxConcurrency: 2,
    onError: error => debugLog("[AUTOMATION]", error),
});

let toolsRegistered = false;

export function registerToolActions(): void {
    if (toolsRegistered) return;

    registerAutomationTools(ultronToolRegistry, automationEngine);
    const providerAvailability = {
        mail: Boolean(personalProviderRuntime?.mail),
        calendar: Boolean(personalProviderRuntime?.calendar),
        message: personalProviderRuntime?.configurationMessage,
    };
    if (!ultronToolRegistry.has("automation.createDailyBriefing")) {
        ultronToolRegistry.register(createDailyBriefingAutomationTool(
            automationEngine,
            defaultTimezone,
            {
                available: Boolean(
                    personalProviderRuntime?.configured
                    && (
                        personalProviderRuntime.mail
                        || personalProviderRuntime.tasks
                        || personalProviderRuntime.calendar
                    )
                ),
                message: personalProviderRuntime?.configurationMessage,
            },
        ));
    }
    registerPersonalMonitorTools(ultronToolRegistry, automationEngine, {
        defaultTimeZone: defaultTimezone,
        providerAvailability,
    });

    if (personalProviderRuntime?.mail) {
        const action = createMailWatchAction({
            mail: personalProviderRuntime.mail,
            notifications: notificationCenter,
            state: monitorState,
        });
        if (!automationEngine.actions.has(action.type)) {
            automationEngine.actions.register(action.type, action.execute);
        }
    } else {
        registerUnavailableMonitorAction("mail.watch");
    }

    if (personalProviderRuntime?.calendar) {
        const action = createCalendarReminderAction({
            calendar: personalProviderRuntime.calendar,
            notifications: notificationCenter,
            state: monitorState,
        });
        if (!automationEngine.actions.has(action.type)) {
            automationEngine.actions.register(action.type, action.execute);
        }
    } else {
        registerUnavailableMonitorAction("calendar.reminderScan");
    }

    for (const tool of ultronToolRegistry.list()) {
        if (tool.category === "automation") continue;
        // registerToolActions pode ser repetido após uma falha parcial de
        // inicialização; preserve handlers já instalados.
        if (automationEngine.actions.has(tool.name)) continue;
        automationEngine.actions.register(tool.name, async (input, context) => {
            const result = await ultronToolRegistry.execute(tool.name, input, {
                signal: context.signal,
                automationId: context.automationId,
                jobId: context.jobId,
                runId: context.runId,
            });

            if (!result.success) {
                const error = new Error(result.error?.message ?? result.message);
                Object.assign(error, { code: result.error?.code ?? "TOOL_ACTION_FAILED" });
                throw error;
            }

            return toJsonValue(result);
        });
    }

    toolsRegistered = true;
}

export async function startAutomationRuntime(signal?: AbortSignal): Promise<void> {
    registerToolActions();
    await automationEngine.start(signal);
    debugLog("[AUTOMATION] Scheduler pronto.");
}

export async function stopAutomationRuntime(): Promise<void> {
    await automationEngine.stop();
}

function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function registerUnavailableMonitorAction(type: string): void {
    if (automationEngine.actions.has(type)) return;
    automationEngine.actions.register(type, () => {
        const error = new Error(
            personalProviderRuntime?.configurationMessage
                ?? "A conta Google não está configurada para esta automação.",
        );
        Object.assign(error, { code: "PROVIDER_NOT_CONFIGURED" });
        throw error;
    });
}
