import type { ToolResult } from "../../shared/types.ts";
import type { DirectAutomationCommand } from "../ai/ollama.service.ts";
import { fileSystem } from "../filesystem/file-system-service.ts";
import { operationalContext } from "../context/operational-context.ts";
import { applicationResolver } from "../system/application-resolver.ts";
import type { ToolContext } from "../tools/tool.ts";
import { ultronToolRegistry } from "../tools/core-tool-registry.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";
import { requestPerformanceTimelines } from "../utils/request-performance-timeline.ts";
import { parsePersonalIntent } from "./personal-intent-parser.ts";
import { parseMemoryIntent } from "./memory-intent-parser.ts";
import { redactForLog } from "../utils/redaction.ts";
import { formatToolExecutionResponses } from "../tools/tool-response-formatting.ts";

type FastAction = {
    name: string;
    input: Record<string, unknown>;
    category:
        | "system"
        | "filesystem"
        | "smart-home"
        | "information"
        | "memory"
        | "mail"
        | "tasks"
        | "calendar"
        | "automation";
    serialKey?: string;
    confidence: number;
};

export interface FastIntentResult {
    handled: true;
    response: string;
    needsInterpretation: boolean;
    results: ToolResult[];
    actions: ReadonlyArray<Pick<FastAction, "name" | "input" | "confidence">>;
}

type AutomationParser = (input: string) => DirectAutomationCommand | null;

function normalize(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[.!?]+$/g, "")
        .trim();
}

function splitCommands(input: string): string[] {
    return input
        .split(/\s+(?:e|depois)\s+(?=(?:abre|abra|abrir|inicia|inicie|liga|ligue|acende|acenda|apaga|apague|desliga|desligue|deixa|coloca|ajusta|muda|entra|vai|volta|lista|liste|cria|crie|procura|procure|encontra|encontre|leia|ler|resuma|resume|marca|marque|conclui|conclua|conecta|conecte)\b)/i)
        .map(part => part.trim())
        .filter(Boolean);
}

const portugueseDigits: Record<string, string> = {
    zero: "0", um: "1", uma: "1", dois: "2", duas: "2", tres: "3",
    quatro: "4", cinco: "5", seis: "6", sete: "7", oito: "8", nove: "9",
};

export function extractTelevisionPairingCode(input: string): string | null {
    const text = normalize(input).replace(
        /^(?:o )?(?:codigo|pin)(?: da (?:tv|televisao))?\s+/,
        "",
    );
    const compact = text.replace(/[^a-z0-9]/g, "").toUpperCase();

    if (/^[A-Z0-9]{6}$/.test(compact)) return compact;

    const spoken = text
        .split(/\s+/)
        .map(part => portugueseDigits[part])
        .filter((part): part is string => part !== undefined)
        .join("");
    return spoken.length === 6 ? spoken : null;
}

export class FastIntentRouter {
    private readonly registry = ultronToolRegistry;
    private lastDevice: "light" | "television" | string | null = null;
    private lightState = { brightness: 50, temperature: 50, power: undefined as boolean | undefined };

    constructor(private readonly parseAutomation: AutomationParser) {}

    start(): void {
        applicationResolver.start();
        fileSystem.startIndexing();
    }

    hasPendingConfirmation(conversationId: string): boolean {
        return this.registry.pendingConfirmation(conversationId) !== null;
    }

    /** Planejamento puro o suficiente para diagnóstico/testes; não executa tools. */
    planActions(input: string): ReadonlyArray<Pick<FastAction,
        "name" | "input" | "category" | "confidence" | "serialKey"
    >> {
        return this.plan(input).map(action => ({ ...action }));
    }

    async execute(input: string, context: ToolContext = {}): Promise<FastIntentResult | null> {
        const intentStartedAt = performance.now();
        const timeline = context.requestId
            ? requestPerformanceTimelines.get(context.requestId)
            : undefined;
        timeline?.mark("intent_start");
        const confirmationDecision = context.conversationId
            ? this.confirmationDecision(input, context.conversationId)
            : null;
        if (confirmationDecision) {
            timeline?.mark("intent_end");
            perf.record("Intent detection", performance.now() - intentStartedAt);
            const execution = confirmationDecision === "approve"
                ? await this.registry.approvePendingConfirmation(
                    context.conversationId!,
                    context,
                )
                : this.registry.cancelPendingConfirmation(context.conversationId!);
            if (!execution) return null;
            const remaining = execution.remainingConfirmations ?? 0;
            const response = [
                this.registry.formatResponse(execution.name, execution.result),
                remaining === 1
                    ? "Ainda há uma ação aguardando sua confirmação."
                    : remaining > 1
                        ? `Ainda há ${remaining} ações aguardando sua confirmação.`
                        : "",
            ].filter(Boolean).join(" ");
            return {
                handled: true,
                response,
                needsInterpretation: false,
                results: [execution.result],
                actions: [{ name: execution.name, input: {}, confidence: 1 }],
            };
        }
        let actions: FastAction[];
        try {
            actions = this.plan(input);
        } finally {
            timeline?.mark("intent_end");
        }
        perf.record("Intent detection", performance.now() - intentStartedAt);

        if (actions.length === 0) return null;

        debugLog("[INTENT]", actions.map(action => ({
            type: action.name,
            confidence: action.confidence,
            target: redactForLog(action.input),
            requestId: context.requestId,
            conversationId: context.conversationId,
        })));
        perf.record("Tool selection", performance.now() - intentStartedAt);
        const chains = new Map<string, Promise<void>>();
        const results: ToolResult[] = Array.from({ length: actions.length });
        const executions = actions.map((action, index) => {
            const execute = async (): Promise<void> => {
                context.signal?.throwIfAborted();
                debugLog(`[TOOL] ${action.name}`, {
                    input: redactForLog(action.input),
                    requestId: context.requestId,
                    conversationId: context.conversationId,
                    toolCallId: context.toolCallId
                        ?? (context.requestId ? `${context.requestId}:${index + 1}` : undefined),
                });
                try {
                    results[index] = await perf.measure(
                        `Tool ${action.name}`,
                        () => this.registry.execute(action.name, action.input, {
                            ...context,
                            toolCallId: context.toolCallId
                                ?? (context.requestId ? `${context.requestId}:${index + 1}` : undefined),
                        }),
                    );
                } catch (error) {
                    if (context.signal?.aborted) throw error;
                    debugLog(`[TOOL] Falha em ${action.name}:`, error);
                    const message = action.name === "automation"
                        ? "Não consegui executar essa automação."
                        : `Não consegui executar ${action.name}.`;
                    results[index] = { success: false, message, speech: message };
                }
                this.remember(action, results[index]);
            };
            const key = action.serialKey
                ?? this.registry.serializationKey(action.name, action.input);

            if (!key) return execute();
            const previous = chains.get(key) ?? Promise.resolve();
            const current = previous.then(execute);
            chains.set(key, current);
            return current;
        });

        await Promise.all(executions);
        const failures = results.filter(result => !result.success);
        const needsInterpretation = failures.length === 0 && actions.some(action => (
            this.registry.get(action.name)?.responsePolicy?.deterministic !== true
        ));
        const response = formatToolExecutionResponses(
            this.registry,
            actions.map((action, index) => ({
                name: action.name,
                result: results[index],
            })),
        );

        return {
            handled: true,
            response,
            needsInterpretation,
            results,
            actions: actions.map(({ name, input: actionInput, confidence }) => ({ name, input: actionInput, confidence })),
        };
    }

    private confirmationDecision(
        input: string,
        conversationId: string,
    ): "approve" | "cancel" | null {
        if (!this.hasPendingConfirmation(conversationId)) return null;
        const text = normalize(input);
        if (/^(?:sim|confirmo|confirmado|pode|pode fazer|pode enviar|prossegue|continue|faz isso)$/.test(text)) {
            return "approve";
        }
        if (/^(?:nao|para|pare|cancela|cancelar|deixa pra la|esquece|esquece isso|nao faca|melhor nao)$/.test(text)) {
            return "cancel";
        }
        return null;
    }

    private plan(input: string): FastAction[] {
        // A title may itself contain "e abre ...". Parse the complete explicit
        // note query before generic multi-command splitting to keep it data.
        const memory = parseMemoryIntent(input);
        if (memory) return [memory];
        const parts = splitCommands(input);
        const actions: FastAction[] = [];
        let plannedDevice = this.lastDevice;

        for (const originalPart of parts) {
            const part = originalPart.replace(/^\s*(?:ultron[, ]*)/i, "").trim();
            const text = normalize(part);
            const pairingCode = /^(?:(?:o )?(?:codigo|pin)\b|[0-9][0-9\s-]{5,})/.test(text)
                ? extractTelevisionPairingCode(text)
                : null;

            if (pairingCode) {
                actions.push({
                    name: "pair_television",
                    input: { code: pairingCode },
                    category: "smart-home",
                    serialKey: "home:television",
                    confidence: 1,
                });
                plannedDevice = "television";
                continue;
            }

            const automation = this.parseAutomation(part) ?? this.contextualAutomation(text, plannedDevice);

            if (automation) {
                const serialKey = automation.name === "control_light"
                    ? "home:light"
                    : automation.name === "control_tv"
                        ? "home:television"
                        : `home:${normalize(automation.args.device)}`;
                actions.push({
                    name: automation.name,
                    input: automation.args as unknown as Record<string, unknown>,
                    category: "smart-home",
                    serialKey,
                    confidence: 0.98,
                });
                plannedDevice = automation.name === "control_light" ? "light" : automation.name === "control_tv" ? "television" : automation.args.device;
                continue;
            }

            const personal = parsePersonalIntent(part, {
                operationalContext: operationalContext.snapshot(),
            });
            if (personal) {
                actions.push({
                    name: personal.name,
                    input: personal.input,
                    category: personal.category,
                    serialKey: personal.serialKey,
                    confidence: personal.confidence,
                });
                continue;
            }

            if (/\b(?:que horas|hora atual|horas sao)\b/.test(text)) {
                actions.push({ name: "get_current_time", input: {}, category: "information", confidence: 1 });
                continue;
            }

            if (/^(?:clear|cls|limpa(?:r)? (?:o )?terminal)$/.test(text)) {
                actions.push({ name: "clear_terminal", input: {}, category: "system", confidence: 1 });
                continue;
            }

            const create = text.match(/^(?:cria|crie|criar) (?:uma )?pasta (?:chamada |com o nome )?(.+)$/);
            if (create) {
                actions.push({ name: "create_directory", input: { name: create[1] }, category: "filesystem", serialKey: "filesystem", confidence: 0.99 });
                continue;
            }

            if (/^(?:volta|voltar|sobe|pasta anterior)$/.test(text)) {
                actions.push({ name: "change_directory", input: { path: "volta" }, category: "filesystem", serialKey: "filesystem", confidence: 1 });
                continue;
            }

            const change = text.match(/^(?:entra|entre|vai|va) (?:em |na |no |para |pra )?(?:a |o )?(?:pasta )?(.+)$/);
            if (change) {
                actions.push({ name: "change_directory", input: { path: change[1] }, category: "filesystem", serialKey: "filesystem", confidence: 0.96 });
                continue;
            }

            if (/^(?:lista|liste|listar|mostra|mostre)(?: (?:os )?(?:arquivos|itens|conteudo|o que tem)(?: (?:daqui|aqui|nessa pasta))?)?$/.test(text)) {
                actions.push({ name: "list_directory", input: {}, category: "filesystem", serialKey: "filesystem", confidence: 0.98 });
                continue;
            }

            if (/^(?:qual|qual era|onde) (?:e |era )?(?:mesmo )?(?:a )?pasta/.test(text) || /^(?:onde estamos|pasta atual)$/.test(text)) {
                actions.push({ name: "get_current_directory", input: {}, category: "filesystem", serialKey: "filesystem", confidence: 0.95 });
                continue;
            }

            const find = text.match(/^(?:procura|procure|encontra|encontre|onde (?:esta|fica)) (?:o |a |meu |minha )?(?:(arquivo|pasta|projeto) )?(.+)$/);
            if (find) {
                const isFile = find[1] === "arquivo" || /\.[a-z0-9]{1,8}$/i.test(find[2]);
                actions.push({
                    name: isFile ? "find_file" : "find_directory",
                    input: { query: find[2] }, category: "filesystem", serialKey: "filesystem", confidence: 0.94,
                });
                continue;
            }

            const editor = text.match(/^(?:abre|abra|abrir) (?:(.+?) )?(?:no|com o) (?:vs code|vscode|visual studio code)$/);
            if (editor) {
                actions.push({ name: "open_in_editor", input: { path: editor[1] }, category: "filesystem", serialKey: "filesystem", confidence: 0.99 });
                continue;
            }

            const explorer = text.match(/^(?:abre|abra|abrir) (?:(.+?) )?(?:no|com o) explorer$/);
            if (explorer) {
                actions.push({ name: "open_in_explorer", input: { path: explorer[1] }, category: "filesystem", serialKey: "filesystem", confidence: 0.99 });
                continue;
            }

            const project = text.match(/^(?:abre|abra|abrir) (?:o )?(?:meu )?(?:projeto|pasta) (.+)$/);
            if (project) {
                actions.push({ name: "open_project", input: { query: project[1] }, category: "filesystem", serialKey: "filesystem", confidence: 0.96 });
                continue;
            }

            const knownDirectory = text.match(/^(?:abre|abra|abrir) (?:os |as |a |o )?(documentos|downloads|desktop|area de trabalho|projetos|github|onedrive)$/);
            if (knownDirectory) {
                actions.push({ name: "open_directory", input: { path: knownDirectory[1] }, category: "filesystem", serialKey: "filesystem", confidence: 0.99 });
                continue;
            }

            const open = text.match(/^(?:abre|abra|abrir|inicia|inicie|iniciar) (?:o |a )?(.+)$/);
            if (open) {
                actions.push({ name: "open_application", input: { application: open[1] }, category: "system", confidence: 0.95 });
                continue;
            }

            const close = text.match(/^(?:fecha|feche|fechar|encerra|encerre) (?:o |a )?(.+)$/);
            if (close) {
                actions.push({ name: "close_application", input: { application: close[1] }, category: "system", confidence: 0.94 });
            }
        }

        return actions;
    }

    private contextualAutomation(text: string, device: string | null): DirectAutomationCommand | null {
        if (device !== "light") return null;
        const percentage = text.match(/\b(?:deixa|coloca|ajusta|muda)?\s*(?:ela|a luz)?\s*(?:em|para|a)?\s*(100|[1-9]?\d)\s*%/)?.[1];

        if (percentage !== undefined) {
            return { name: "control_light", args: { action: "brightness", brightness: Number(percentage) } };
        }

        if (/\bmais quente\b|\besquenta\b/.test(text)) {
            return {
                name: "control_light",
                args: {
                    action: "white",
                    brightness: this.lightState.brightness,
                    temperature: Math.max(0, this.lightState.temperature - 15),
                },
            };
        }

        if (/\bmais fria\b|\bmais frio\b|\besfria\b/.test(text)) {
            return {
                name: "control_light",
                args: {
                    action: "white",
                    brightness: this.lightState.brightness,
                    temperature: Math.min(100, this.lightState.temperature + 15),
                },
            };
        }

        return null;
    }

    private remember(action: FastAction, result: ToolResult): void {
        if (!result.success) return;

        const resultData = result.data as { path?: string; application?: string } | undefined;

        if (action.name === "open_application") {
            const application = resultData?.application
                ?? String(action.input.application ?? "");
            operationalContext.set({
                type: "application",
                id: application,
                label: application,
            });
            return;
        }

        if (action.category === "filesystem" && resultData?.path) {
            operationalContext.set({
                type: action.name === "open_project" ? "project" : "file",
                id: resultData.path,
                label: resultData.path,
                metadata: { tool: action.name },
            });
            return;
        }

        if (!["control_light", "control_tv", "control_home_device"].includes(action.name)) {
            return;
        }
        const command = {
            name: action.name,
            args: action.input,
        } as DirectAutomationCommand;

        if (command.name === "control_light") {
            this.lastDevice = "light";
            operationalContext.set({ type: "device", id: "light", label: "lâmpada" });
            if (command.args.action === "on") this.lightState.power = true;
            if (command.args.action === "off") this.lightState.power = false;
            if (command.args.brightness !== undefined) this.lightState.brightness = command.args.brightness;
            if (command.args.temperature !== undefined) this.lightState.temperature = command.args.temperature;
        } else if (command.name === "control_tv") {
            this.lastDevice = "television";
            operationalContext.set({ type: "device", id: "television", label: "televisão" });
        } else {
            this.lastDevice = command.args.device;
            operationalContext.set({
                type: "device",
                id: command.args.device,
                label: command.args.device,
            });
        }
    }
}
