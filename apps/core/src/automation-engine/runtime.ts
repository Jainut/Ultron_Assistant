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
    createStartupBriefingAutomationTool,
    createCalendarReminderAction,
    createMailWatchAction,
    createMonitorStateStore,
    registerPersonalMonitorTools,
} from "../personal-automation/index.ts";
import { AutomationEngine } from "./automation-engine.ts";
import type { Job, JsonValue } from "./types.ts";

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
    canRetryJob: canRetryAutomationJob,
    awaitInitialTick: false,
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
    const briefingAvailability = {
        available: Boolean(
            personalProviderRuntime?.configured
            && (
                personalProviderRuntime.mail
                || personalProviderRuntime.tasks
                || personalProviderRuntime.calendar
            )
        ),
        message: personalProviderRuntime?.configurationMessage,
    };
    if (!ultronToolRegistry.has("automation.createDailyBriefing")) {
        ultronToolRegistry.register(createDailyBriefingAutomationTool(
            automationEngine,
            defaultTimezone,
            briefingAvailability,
        ));
    }
    if (!ultronToolRegistry.has("automation.createStartupBriefing")) {
        ultronToolRegistry.register(createStartupBriefingAutomationTool(
            automationEngine,
            defaultTimezone,
            briefingAvailability,
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

// Explicitly reviewed operations only: a category/capability named "read" can
// still open apps, change cwd or publish notifications in existing tools.
const READ_ONLY_ACTIONS = new Set([
    "get_current_time", "get_current_directory", "list_directory", "find_directory", "find_file",
    "mail.list", "mail.search", "mail.read", "mail.thread", "mail.summarize",
    "task.list", "task.search", "task.get",
    "calendar.list", "calendar.search", "calendar.checkConflicts", "notification.list",
]);

/** The whole batch restarts on retry, so every action must be safe to repeat. */
export function canRetryAutomationJob(job: Job): boolean {
    return job.actions.length > 0 && job.actions.every(action => {
        if (READ_ONLY_ACTIONS.has(action.type)) return true;
        const input = action.input && typeof action.input === "object" && !Array.isArray(action.input)
            ? action.input : undefined;
        if (!input) return false;
        if (["control_light", "control_tv", "control_home_device"].includes(action.type)) {
            return input.action === "status";
        }
        if (action.type === "mail.watch") {
            // The installed monitor uses watchId + messageId and durable NotificationCenter dedupe.
            return typeof input.watchId === "string" && input.watchId.trim().length > 0;
        }
        if (action.type === "calendar.reminderScan") {
            return typeof input.reminderId === "string" && input.reminderId.trim().length > 0;
        }
        if (action.type === "personal.dailyBriefing") {
            if (input.publishNotification !== true) return true;
            // A clock-relative briefing can cross a date boundary and change its dedupe key.
            return typeof input.at === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input.at)
                && Number.isFinite(Date.parse(input.at));
        }
        return false;
    });
}

function registerUnavailableMonitorAction(type: string): void {
    if (automationEngine.actions.has(type)) return;
    automationEngine.actions.register(type, () => {
        const error = new Error(
            personalProviderRuntime?.configurationMessage
                ?? "Nenhum provider pessoal está configurado para esta automação.",
        );
        Object.assign(error, { code: "PROVIDER_NOT_CONFIGURED" });
        throw error;
    });
}
