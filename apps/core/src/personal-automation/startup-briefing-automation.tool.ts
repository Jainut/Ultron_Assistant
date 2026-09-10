import type { AutomationEngine } from "../automation-engine/automation-engine.ts";
import type { Automation } from "../automation-engine/types.ts";
import type { ToolDefinition } from "../tools/tool.ts";
import {
    normalizeDailyBriefingSources,
    type DailyBriefingSource,
} from "./daily-briefing.ts";
import { KeyedExecutionQueue } from "./monitors/keyed-execution.ts";

const DEFAULT_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 300;
const DEFAULT_MAX_EMAILS = 20;
const creationQueues = new WeakMap<AutomationEngine, KeyedExecutionQueue>();

export interface CreateStartupBriefingInput {
    readonly delaySeconds?: number;
    readonly timeZone?: string;
    readonly maxEmails?: number;
    readonly sources?: DailyBriefingSource[];
}

export interface StartupBriefingAutomationResult {
    readonly automation: Automation;
    readonly created: boolean;
}

export interface StartupBriefingAvailability {
    readonly available: boolean;
    readonly message?: string;
}

/**
 * Creates a persisted system.startup → personal.dailyBriefing composition.
 * The source list is explicit so a mail-only request does not query Tasks or Calendar.
 */
export function createStartupBriefingAutomationTool(
    engine: AutomationEngine,
    defaultTimeZone = "America/Sao_Paulo",
    availability: StartupBriefingAvailability = { available: true },
): ToolDefinition<CreateStartupBriefingInput, StartupBriefingAutomationResult> {
    return {
        name: "automation.createStartupBriefing",
        aliases: ["automation.startupBriefing", "create_startup_briefing"],
        description: "Na próxima inicialização do Ultron, consulta e publica um resumo das fontes pessoais escolhidas.",
        category: "automation",
        inputSchema: {
            type: "object",
            properties: {
                delaySeconds: {
                    type: "integer",
                    minimum: 0,
                    maximum: MAX_DELAY_SECONDS,
                },
                timeZone: { type: "string", minLength: 1 },
                maxEmails: { type: "integer", minimum: 1, maximum: 100 },
                sources: {
                    type: "array",
                    minItems: 1,
                    items: { type: "string", enum: ["calendar", "tasks", "mail"] },
                },
            },
            additionalProperties: false,
        },
        capabilities: ["automation.write", "personal.briefing.read"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "confirmed",
        serializeKey: () => "automation:create-startup-briefing",
        responsePolicy: {
            deterministic: true,
            format: result => result.success
                ? "Verificação da inicialização configurada."
                : result.message,
        },
        async execute(input, context) {
            context.signal?.throwIfAborted();
            if (!availability.available) {
                const message = availability.message
                    ?? "Configure uma conta pessoal antes de criar essa verificação.";
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

            const delaySeconds = checkedDelay(input.delaySeconds);
            const timeZone = checkedTimeZone(input.timeZone ?? defaultTimeZone);
            const sources = normalizeDailyBriefingSources(input.sources);
            const maxEmails = sources.includes("mail")
                ? checkedMaxEmails(input.maxEmails)
                : undefined;
            const fingerprint = JSON.stringify({
                delaySeconds,
                timeZone,
                maxEmails: maxEmails ?? null,
                sources,
            });

            return await queueFor(engine).run(
                "startup-briefing",
                async () => {
                    context.signal?.throwIfAborted();
                    const existing = (await engine.listAutomations()).find(automation => (
                        automation.status !== "archived"
                        && automation.metadata?.kind === "personal.startup-briefing"
                        && automation.metadata?.fingerprint === fingerprint
                    ));
                    if (existing) {
                        return {
                            success: true,
                            status: "confirmed" as const,
                            message: "Essa verificação da inicialização já estava configurada.",
                            speech: "Essa verificação já estava configurada.",
                            data: { automation: existing, created: false },
                        };
                    }

                    const automation = await engine.createAutomation({
                        name: startupName(sources),
                        description: "Consulta fontes pessoais e publica somente contagens na inicialização.",
                        trigger: {
                            type: "system.startup",
                            config: { delayMs: delaySeconds * 1_000 },
                        },
                        actions: [{
                            type: "personal.dailyBriefing",
                            input: {
                                timeZone,
                                sources,
                                publishNotification: true,
                                ...(maxEmails === undefined ? {} : { maxEmails }),
                            },
                        }],
                        timezone: timeZone,
                        metadata: {
                            kind: "personal.startup-briefing",
                            fingerprint,
                        },
                    });
                    return {
                        success: true,
                        status: "confirmed" as const,
                        message: "Verificação criada para a próxima inicialização do Ultron.",
                        speech: "Verificação da inicialização configurada.",
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

function checkedDelay(value: number | undefined): number {
    const delay = value ?? DEFAULT_DELAY_SECONDS;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) {
        throw new RangeError(`delaySeconds deve estar entre 0 e ${MAX_DELAY_SECONDS}.`);
    }
    return delay;
}

function checkedMaxEmails(value: number | undefined): number {
    const maxEmails = value ?? DEFAULT_MAX_EMAILS;
    if (!Number.isSafeInteger(maxEmails) || maxEmails < 1 || maxEmails > 100) {
        throw new RangeError("maxEmails deve estar entre 1 e 100.");
    }
    return maxEmails;
}

function checkedTimeZone(value: string): string {
    const timeZone = value.trim();
    if (!timeZone) throw new RangeError("Timezone vazio.");
    try {
        new Intl.DateTimeFormat("pt-BR", { timeZone }).format();
    } catch {
        throw new RangeError("Timezone inválido.");
    }
    return timeZone;
}

function startupName(sources: readonly DailyBriefingSource[]): string {
    return sources.length === 1 && sources[0] === "mail"
        ? "Verificar emails na inicialização"
        : "Resumo na inicialização";
}
