import type { AutomationEngine } from "../automation-engine/automation-engine.ts";
import type { Automation } from "../automation-engine/types.ts";
import type { ToolDefinition } from "../tools/tool.ts";
import { KeyedExecutionQueue } from "./monitors/keyed-execution.ts";
import {
    normalizeDailyBriefingSources,
    type DailyBriefingSource,
} from "./daily-briefing.ts";

const creationQueues = new WeakMap<AutomationEngine, KeyedExecutionQueue>();
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const DEFAULT_MAX_EMAILS = 20;

export interface CreateDailyBriefingAutomationInput {
    time: string;
    timeZone?: string;
    daysOfWeek?: number[];
    maxEmails?: number;
    sources?: DailyBriefingSource[];
}

export interface DailyBriefingAutomationResult {
    readonly automation: Automation;
    readonly created: boolean;
}

export interface DailyBriefingAutomationAvailability {
    readonly available: boolean;
    readonly message?: string;
}

export function createDailyBriefingAutomationTool(
    engine: AutomationEngine,
    defaultTimeZone = "America/Sao_Paulo",
    availability: DailyBriefingAutomationAvailability = { available: true },
): ToolDefinition<CreateDailyBriefingAutomationInput, DailyBriefingAutomationResult> {
    return {
        name: "automation.createDailyBriefing",
        aliases: ["automation.dailyBriefing", "create_daily_briefing"],
        description: "Agenda um resumo persistente de compromissos, tarefas e emails.",
        category: "automation",
        inputSchema: {
            type: "object",
            properties: {
                time: {
                    type: "string",
                    pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
                    description: "Horário local HH:mm.",
                },
                timeZone: { type: "string", minLength: 1 },
                daysOfWeek: {
                    type: "array",
                    minItems: 1,
                    items: { type: "integer", minimum: 0, maximum: 6 },
                },
                maxEmails: { type: "integer", minimum: 1, maximum: 100 },
                sources: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", enum: ["calendar", "tasks", "mail"] },
                },
            },
            required: ["time"],
            additionalProperties: false,
        },
        capabilities: ["automation.write"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "confirmed",
        serializeKey: () => "automation:create-daily-briefing",
        responsePolicy: { deterministic: true },
        async execute(input, context) {
            context.signal?.throwIfAborted();
            if (!availability.available) {
                const message = availability.message
                    ?? "Configure a conta Google antes de agendar o resumo diário.";
                return {
                    success: false,
                    status: "failed",
                    message,
                    speech: message,
                    error: {
                        code: "PROVIDER_NOT_CONFIGURED",
                        message,
                        retryable: false,
                    },
                };
            }
            return await queueFor(engine).run(
                "daily-briefing",
                async () => {
                    context.signal?.throwIfAborted();
                    const timeZone = input.timeZone?.trim()
                        || defaultTimeZone.trim()
                        || "America/Sao_Paulo";
                    const daysOfWeek = normalizeDaysOfWeek(input.daysOfWeek);
                    const sources = normalizeDailyBriefingSources(input.sources);
                    const maxEmails = sources.includes("mail")
                        ? input.maxEmails
                        : undefined;
                    const fingerprint = dailyBriefingFingerprint({
                        ...input,
                        timeZone,
                        daysOfWeek,
                        maxEmails,
                        sources,
                    });
                    const existing = (await engine.listAutomations()).find(
                        automation => isEquivalentDailyBriefing(
                            automation,
                            { ...input, timeZone, daysOfWeek, maxEmails, sources },
                            fingerprint,
                        ),
                    );
                    if (existing) {
                        return {
                            success: true,
                            status: "confirmed" as const,
                            message: "Esse resumo diário já estava agendado.",
                            speech: "Esse resumo diário já estava agendado.",
                            data: { automation: existing, created: false },
                        };
                    }

                    const automation = await engine.createAutomation({
                        name: `Resumo diário às ${input.time}`,
                        description: "Compromissos, tarefas e emails que pedem atenção.",
                        trigger: {
                            type: "time.schedule",
                            config: {
                                schedule: {
                                    kind: "daily",
                                    time: input.time,
                                    timezone: timeZone,
                                    ...(daysOfWeek ? { daysOfWeek } : {}),
                                },
                            },
                        },
                        actions: [{
                            type: "personal.dailyBriefing",
                            input: {
                                timeZone,
                                publishNotification: true,
                                sources,
                                ...(maxEmails === undefined
                                    ? {}
                                    : { maxEmails }),
                            },
                        }],
                        timezone: timeZone,
                        metadata: {
                            kind: "personal.daily-briefing",
                            fingerprint,
                        },
                    });
                    return {
                        success: true,
                        status: "confirmed" as const,
                        message: `Resumo diário agendado para ${input.time}.`,
                        speech: `Resumo diário agendado para ${input.time}.`,
                        data: { automation, created: true },
                    };
                },
                context.signal,
            );
        },
    };
}

function queueFor(engine: AutomationEngine): KeyedExecutionQueue {
    let queue = creationQueues.get(engine);
    if (!queue) {
        queue = new KeyedExecutionQueue();
        creationQueues.set(engine, queue);
    }
    return queue;
}

function normalizeDaysOfWeek(days: readonly number[] | undefined): number[] | undefined {
    if (days === undefined) return undefined;
    if (
        days.length === 0
        || days.some(day => !Number.isSafeInteger(day) || day < 0 || day > 6)
    ) {
        throw new RangeError("daysOfWeek deve conter dias entre 0 e 6.");
    }
    return [...new Set(days)].sort((left, right) => left - right);
}

function dailyBriefingFingerprint(input: CreateDailyBriefingAutomationInput): string {
    const sources = normalizeDailyBriefingSources(input.sources);
    return JSON.stringify({
        time: input.time,
        timeZone: input.timeZone,
        daysOfWeek: input.daysOfWeek ?? ALL_DAYS,
        maxEmails: sources.includes("mail")
            ? input.maxEmails ?? DEFAULT_MAX_EMAILS
            : null,
        sources,
    });
}

function isEquivalentDailyBriefing(
    automation: Automation,
    input: CreateDailyBriefingAutomationInput,
    fingerprint: string,
): boolean {
    if (
        automation.status === "archived"
        || automation.metadata?.kind !== "personal.daily-briefing"
    ) {
        return false;
    }
    if (automation.metadata.fingerprint === fingerprint) return true;
    if (automation.trigger.type !== "time.schedule") return false;

    const schedule = automation.trigger.config.schedule;
    if (schedule === null || typeof schedule !== "object" || Array.isArray(schedule)) {
        return false;
    }
    const storedDays = Array.isArray(schedule.daysOfWeek)
        ? normalizeDaysOfWeek(schedule.daysOfWeek as number[])
        : undefined;
    const action = automation.actions.find(value => value.type === "personal.dailyBriefing");
    const actionInput = action?.input;
    const storedMaxEmails = actionInput
        && typeof actionInput === "object"
        && !Array.isArray(actionInput)
        ? actionInput.maxEmails
        : undefined;
    const storedSources = storedBriefingSources(actionInput);
    if (!storedSources) return false;
    return schedule.kind === "daily"
        && schedule.time === input.time
        && automation.timezone === input.timeZone
        && sameNumbers(storedDays ?? ALL_DAYS, input.daysOfWeek ?? ALL_DAYS)
        && (!storedSources.includes("mail")
            || (storedMaxEmails ?? DEFAULT_MAX_EMAILS)
                === (input.maxEmails ?? DEFAULT_MAX_EMAILS))
        && sameStrings(storedSources, normalizeDailyBriefingSources(input.sources));
}

function sameNumbers(
    left: readonly number[],
    right: readonly number[],
): boolean {
    return left.length === right.length
        && left.every((value, index) => value === right[index]);
}

function storedBriefingSources(
    input: unknown,
): DailyBriefingSource[] | null {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const sources = (input as Record<string, unknown>).sources;
    if (sources === undefined) return normalizeDailyBriefingSources(undefined);
    if (!Array.isArray(sources)) return null;
    try {
        return normalizeDailyBriefingSources(sources as DailyBriefingSource[]);
    } catch {
        return null;
    }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length
        && left.every((value, index) => value === right[index]);
}
