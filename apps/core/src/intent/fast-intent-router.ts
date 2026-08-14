import type { ToolResult } from "../../shared/types.ts";
import { clearTerminal } from "../../tools/clear-terminal.tool.ts";
import { getTime } from "../../tools/clock.tool.ts";
import {
    controlHomeDevice,
    controlTelevision,
    submitTelevisionPairingCode,
} from "../../tools/home-automation.tool.ts";
import { controlLight, type LightAction } from "../../tools/light.tool.ts";
import { closeApp, openApp } from "../../tools/open-app.tool.ts";
import { filesystemTools } from "../../tools/filesystem/filesystem.tools.ts";
import type { DirectAutomationCommand } from "../ai/ollama.service.ts";
import { fileSystem } from "../filesystem/file-system-service.ts";
import { applicationResolver } from "../system/application-resolver.ts";
import type { ToolContext } from "../tools/tool.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";

type FastAction = {
    name: string;
    input: Record<string, unknown>;
    category: "system" | "filesystem" | "smart-home" | "information";
    serialKey?: string;
    confidence: number;
};

export interface FastIntentResult {
    handled: true;
    response: string;
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
        .split(/\s+(?:e|depois)\s+(?=(?:abre|abra|abrir|inicia|inicie|liga|ligue|acende|acenda|apaga|apague|desliga|desligue|deixa|coloca|ajusta|muda|entra|vai|volta|lista|cria|procura|encontra)\b)/i)
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

function automationResult(command: DirectAutomationCommand, raw: string): ToolResult {
    let parsed: {
        success?: boolean;
        message?: string;
        error?: string;
        fallback_error?: string;
        state?: { is_on?: boolean; pairingRequired?: boolean };
    } = {};

    try {
        parsed = JSON.parse(raw) as typeof parsed;
    } catch {
        return { success: true, message: raw, speech: raw };
    }

    if (parsed.success === false) {
        const message = parsed.message ?? parsed.fallback_error ?? parsed.error ?? "Não foi possível executar o comando.";
        return { success: false, message, speech: message };
    }

    if (command.name === "control_light") {
        const messages: Partial<Record<LightAction, string>> = {
            on: "Lâmpada acesa.",
            off: "Lâmpada apagada.",
            color: "Cor ajustada.",
            brightness: "Brilho ajustado.",
            white: "Temperatura ajustada.",
        };
        const speech = command.args.action === "status"
            ? parsed.state?.is_on === true ? "A lâmpada está acesa." : parsed.state?.is_on === false ? "A lâmpada está apagada." : "Estado consultado."
            : messages[command.args.action] ?? "Feito.";
        return { success: true, message: raw, speech, data: parsed };
    }

    if (command.name === "control_tv") {
        const messages: Partial<Record<string, string>> = {
            on: "Televisão ligada.", off: "Televisão desligada.", volume_up: "Volume aumentado.",
            volume_down: "Volume diminuído.", mute: "Televisão silenciada.", unmute: "Som restaurado.",
            play: "Reprodução iniciada.", pause: "Reprodução pausada.",
        };
        return {
            success: true,
            message: raw,
            speech: parsed.state?.pairingRequired
                ? parsed.message
                : messages[command.args.action] ?? parsed.message ?? "Feito.",
            data: parsed,
        };
    }

    return { success: true, message: parsed.message ?? raw, speech: "Feito.", data: parsed };
}

export class FastIntentRouter {
    private readonly registry = new ToolRegistry();
    private lastDevice: "light" | "television" | string | null = null;
    private lightState = { brightness: 50, temperature: 50, power: undefined as boolean | undefined };

    constructor(private readonly parseAutomation: AutomationParser) {
        for (const tool of filesystemTools) this.registry.register(tool);
        this.registry
            .register<Record<string, never>, ToolResult>({
                name: "get_current_time", description: "Consulta a hora local.", category: "information",
                execute: async () => getTime(),
            })
            .register<Record<string, never>, ToolResult>({
                name: "clear_terminal", description: "Limpa o terminal.", category: "system",
                execute: async () => clearTerminal(),
            })
            .register<{ application: string }, ToolResult>({
                name: "open_application", description: "Localiza e abre um aplicativo.", category: "system",
                execute: (input, context) => openApp(input.application, context),
            })
            .register<{ application: string }, ToolResult>({
                name: "close_application", description: "Fecha um aplicativo localizado com segurança.", category: "system",
                execute: (input, context) => closeApp(input.application, context),
            })
            .register<DirectAutomationCommand, ToolResult>({
                name: "automation", description: "Executa automação residencial determinística.", category: "smart-home",
                execute: async (command, context) => {
                    context?.signal?.throwIfAborted();
                    const raw = command.name === "control_light"
                        ? await controlLight(command.args, context)
                        : command.name === "control_tv"
                            ? await controlTelevision(command.args.action, context)
                            : await controlHomeDevice(command.args.device, command.args.action, context);
                    return automationResult(command, raw);
                },
            })
            .register<{ code: string }, ToolResult>({
                name: "pair_television",
                description: "Envia o PIN exibido pela Android TV para concluir o pareamento.",
                category: "smart-home",
                execute: async (input, context) => {
                    const raw = await submitTelevisionPairingCode(input.code, context);
                    let parsed: { success?: boolean; message?: string; state?: unknown } = {};

                    try {
                        parsed = JSON.parse(raw) as typeof parsed;
                    } catch {
                        return { success: false, message: raw, speech: raw };
                    }

                    const message = parsed.message ?? "NÃ£o consegui concluir o pareamento da TV.";
                    return {
                        success: parsed.success === true,
                        message,
                        speech: message,
                        data: parsed.state,
                    };
                },
            });
    }

    start(): void {
        applicationResolver.start();
        fileSystem.startIndexing();
    }

    async execute(input: string, context: ToolContext = {}): Promise<FastIntentResult | null> {
        const intentStartedAt = performance.now();
        const actions = this.plan(input);
        perf.record("Intent detection", performance.now() - intentStartedAt);

        if (actions.length === 0) return null;

        debugLog("[INTENT]", actions.map(action => ({
            type: action.name,
            confidence: action.confidence,
            target: action.input,
        })));
        perf.record("Tool selection", performance.now() - intentStartedAt);
        const chains = new Map<string, Promise<void>>();
        const results: ToolResult[] = Array.from({ length: actions.length });
        const executions = actions.map((action, index) => {
            const execute = async (): Promise<void> => {
                context.signal?.throwIfAborted();
                debugLog(`[TOOL] ${action.name}`, action.input);
                try {
                    results[index] = await perf.measure(
                        `Tool ${action.name}`,
                        () => this.registry.execute<ToolResult>(action.name, action.input, context),
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
            const key = action.serialKey;

            if (!key) return execute();
            const previous = chains.get(key) ?? Promise.resolve();
            const current = previous.then(execute);
            chains.set(key, current);
            return current;
        });

        await Promise.all(executions);
        const failures = results.filter(result => !result.success);
        const response = failures.length > 0
            ? failures.map(result => result.speech ?? result.message).join(" ")
            : results.length > 1
                ? "Feito."
                : results[0].speech ?? results[0].message;

        return {
            handled: true,
            response,
            results,
            actions: actions.map(({ name, input: actionInput, confidence }) => ({ name, input: actionInput, confidence })),
        };
    }

    private plan(input: string): FastAction[] {
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
                actions.push({ name: "automation", input: automation as unknown as Record<string, unknown>, category: "smart-home", serialKey, confidence: 0.98 });
                plannedDevice = automation.name === "control_light" ? "light" : automation.name === "control_tv" ? "television" : automation.args.device;
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
        if (!result.success || action.name !== "automation") return;
        const command = action.input as unknown as DirectAutomationCommand;

        if (command.name === "control_light") {
            this.lastDevice = "light";
            if (command.args.action === "on") this.lightState.power = true;
            if (command.args.action === "off") this.lightState.power = false;
            if (command.args.brightness !== undefined) this.lightState.brightness = command.args.brightness;
            if (command.args.temperature !== undefined) this.lightState.temperature = command.args.temperature;
        } else if (command.name === "control_tv") {
            this.lastDevice = "television";
        } else {
            this.lastDevice = command.args.device;
        }
    }
}
