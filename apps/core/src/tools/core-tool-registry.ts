import type { ActionStatus, ToolResult } from "../../shared/types.ts";
import { clearTerminal } from "../../tools/clear-terminal.tool.ts";
import { getTime } from "../../tools/clock.tool.ts";
import { filesystemTools } from "../../tools/filesystem/filesystem.tools.ts";
import {
    controlHomeDevice,
    controlTelevision,
    submitTelevisionPairingCode,
    type TelevisionAction,
} from "../../tools/home-automation.tool.ts";
import { controlLight, type LightAction } from "../../tools/light.tool.ts";
import { closeApp, openApp } from "../../tools/open-app.tool.ts";
import type { ToolContext, ToolDefinition } from "./tool.ts";
import { ToolRegistry } from "./tool-registry.ts";
import {
    registerPersonalProviderTools,
} from "./personal/index.ts";
import type { PersonalProviderRuntime } from "../providers/personal-provider-runtime.ts";
import { notificationCenter } from "../notifications/runtime.ts";
import { createNotificationTools } from "./notifications/index.ts";
import { createDailyBriefingTool } from "../personal-automation/index.ts";
import { obsidianIndex } from "../memory/runtime.ts";
import { createObsidianTools } from "./memory/obsidian.tools.ts";

export let personalProviderRuntime: PersonalProviderRuntime | undefined;

interface LightInput {
    action: LightAction;
    red?: number;
    green?: number;
    blue?: number;
    brightness?: number;
    temperature?: number;
}

interface TelevisionInput {
    action: TelevisionAction;
}

interface HomeDeviceInput {
    device: string;
    action: "on" | "off" | "toggle" | "status" | "open" | "close";
}

interface AutomationPayload {
    success?: boolean;
    message?: string;
    error?: string;
    fallback_error?: string;
    confirmed?: boolean;
    optimistic?: boolean;
    status?: ActionStatus;
    state?: Record<string, unknown>;
    [key: string]: unknown;
}

function parsePayload(raw: string): AutomationPayload {
    try {
        return JSON.parse(raw) as AutomationPayload;
    } catch {
        return { success: true, message: raw };
    }
}

function actionStatus(payload: AutomationPayload, action: string): ActionStatus {
    if (payload.success === false) return "failed";
    const explicitStatus = payload.status ?? payload.state?.status;
    if (
        explicitStatus === "confirmed" || explicitStatus === "accepted"
        || explicitStatus === "optimistic" || explicitStatus === "unknown"
        || explicitStatus === "failed"
    ) return explicitStatus;
    if (payload.confirmed === true || payload.state?.confirmed === true) {
        return "confirmed";
    }
    if (payload.optimistic === true || payload.state?.optimistic === true) {
        return "optimistic";
    }
    if (action === "pair") {
        if (payload.state?.paired === true) return "confirmed";
        return payload.state?.pairingRequired === true ? "accepted" : "unknown";
    }
    if (action === "status") {
        // A status request without readback metadata is not itself evidence.
        return "unknown";
    }
    return "accepted";
}

export function automationResult(raw: string, action: string): ToolResult<AutomationPayload> {
    const payload = parsePayload(raw);
    const status = actionStatus(payload, action);
    const message = payload.message
        ?? payload.fallback_error
        ?? payload.error
        ?? raw;

    return {
        success: payload.success !== false,
        status,
        message,
        data: payload,
        error: status === "failed"
            ? { code: "AUTOMATION_FAILED", message, retryable: true }
            : undefined,
    };
}

function lightResponse(input: LightInput, result: ToolResult): string {
    if (!result.success || result.status === "failed") return result.message;
    const confirmed = result.status === "confirmed";
    const confirmedMessages: Partial<Record<LightAction, string>> = {
        on: "Lâmpada acesa.",
        off: "Lâmpada apagada.",
        color: "Cor ajustada.",
        brightness: "Brilho ajustado.",
        white: "Temperatura ajustada.",
        status: result.message,
    };
    const acceptedMessages: Partial<Record<LightAction, string>> = {
        on: "Enviei o comando para acender a lâmpada.",
        off: "Enviei o comando para apagar a lâmpada.",
        color: "Enviei o ajuste de cor.",
        brightness: "Enviei o ajuste de brilho.",
        white: "Enviei o ajuste de temperatura.",
        status: result.message,
    };
    return (confirmed ? confirmedMessages : acceptedMessages)[input.action]
        ?? result.message;
}

function televisionResponse(input: TelevisionInput, result: ToolResult): string {
    if (!result.success || result.status === "failed") return result.message;
    if (input.action === "status" || input.action === "pair") return result.message;

    const confirmedMessages: Partial<Record<TelevisionAction, string>> = {
        on: "Televisão ligada.",
        off: "Televisão desligada.",
        volume_up: "Volume aumentado.",
        volume_down: "Volume diminuído.",
        mute: "Televisão silenciada.",
        unmute: "Som restaurado.",
        play: "Reprodução iniciada.",
        pause: "Reprodução pausada.",
        stop: "Reprodução parada.",
        home: "Tela inicial aberta.",
        back: "Voltei.",
        up: "Cima.",
        down: "Baixo.",
        left: "Esquerda.",
        right: "Direita.",
        select: "Selecionado.",
        menu: "Menu aberto.",
        input: "Entrada alterada.",
        channel_up: "Canal aumentado.",
        channel_down: "Canal diminuído.",
        next: "Próximo.",
        previous: "Anterior.",
    };

    if (result.status === "confirmed") {
        return confirmedMessages[input.action] ?? result.message;
    }

    const acceptedMessages: Partial<Record<TelevisionAction, string>> = {
        on: "Enviei o comando para ligar a televisão; o estado ainda não foi confirmado.",
        off: "Enviei o comando para desligar a televisão; o estado ainda não foi confirmado.",
        toggle: "Enviei o comando de energia para a televisão.",
        volume_up: "Enviei o comando para aumentar o volume.",
        volume_down: "Enviei o comando para diminuir o volume.",
        mute: "Enviei o comando para silenciar a televisão.",
        unmute: "Enviei o comando para restaurar o som.",
        play: "Enviei o comando para reproduzir.",
        pause: "Enviei o comando para pausar.",
        stop: "Enviei o comando para parar a reprodução.",
        home: "Enviei o comando Home.",
        back: "Enviei o comando Voltar.",
        up: "Enviei o comando para cima.",
        down: "Enviei o comando para baixo.",
        left: "Enviei o comando para a esquerda.",
        right: "Enviei o comando para a direita.",
        select: "Enviei o comando OK.",
        menu: "Enviei o comando Menu.",
        input: "Enviei o comando para trocar a entrada.",
        channel_up: "Enviei o comando para o próximo canal.",
        channel_down: "Enviei o comando para o canal anterior.",
        next: "Enviei o comando Próximo.",
        previous: "Enviei o comando Anterior.",
    };

    return acceptedMessages[input.action]
        ?? "Enviei o comando para a televisão.";
}

function define<TInput, TData>(
    definition: ToolDefinition<TInput, TData>,
): ToolDefinition<TInput, TData> {
    return definition;
}

export function createCoreToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();

    for (const tool of filesystemTools) registry.register(tool);
    for (const tool of createNotificationTools(notificationCenter) as readonly ToolDefinition<any, any>[]) {
        registry.register(tool);
    }

    registry.register(define<Record<string, never>, { hour: number; minute: number }>({
        name: "get_current_time",
        description: "Obtém a hora atual do computador do usuário.",
        category: "information",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        aliases: ["clock", "time"],
        capabilities: ["information.time.read"],
        confirmationLevel: "none",
        executionMode: "sync",
        successStatus: "confirmed",
        responsePolicy: { deterministic: true },
        execute: async () => ({ ...getTime(), status: "confirmed" }),
    }));

    registry.register(define<{ application: string }, unknown>({
        name: "open_application",
        description: "Localiza e abre um aplicativo instalado quando solicitado explicitamente.",
        category: "system",
        inputSchema: {
            type: "object",
            properties: { application: { type: "string", description: "Nome do aplicativo." } },
            required: ["application"],
            additionalProperties: false,
        },
        aliases: ["app.open"],
        capabilities: ["application.open"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "accepted",
        serializeKey: input => `application:${input.application.toLowerCase()}`,
        responsePolicy: { deterministic: true },
        execute: async (input, context) => {
            const result = await openApp(input.application, context);
            return {
                ...result,
                status: result.success ? "accepted" : "failed",
            };
        },
    }));

    registry.register(define<{ application: string }, unknown>({
        name: "close_application",
        description: "Fecha um aplicativo em execução quando solicitado explicitamente.",
        category: "system",
        inputSchema: {
            type: "object",
            properties: { application: { type: "string" } },
            required: ["application"],
            additionalProperties: false,
        },
        aliases: ["app.close"],
        capabilities: ["application.close"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "accepted",
        serializeKey: input => `application:${input.application.toLowerCase()}`,
        responsePolicy: { deterministic: true },
        execute: async (input, context) => {
            const result = await closeApp(input.application, context);
            return {
                ...result,
                status: result.success ? "accepted" : "failed",
            };
        },
    }));

    registry.register(define<Record<string, never>, unknown>({
        name: "clear_terminal",
        description: "Limpa a tela do terminal.",
        category: "system",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        capabilities: ["terminal.clear"],
        confirmationLevel: "none",
        executionMode: "sync",
        successStatus: "confirmed",
        responsePolicy: { deterministic: true },
        execute: async () => ({ ...clearTerminal(), status: "confirmed" }),
    }));

    registry.register(define<LightInput, AutomationPayload>({
        name: "control_light",
        description: "Controla a lâmpada: energia, cor RGB, brilho, temperatura e estado.",
        category: "smart-home",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["on", "off", "color", "brightness", "white", "status"] },
                red: { type: "number", minimum: 0, maximum: 255 },
                green: { type: "number", minimum: 0, maximum: 255 },
                blue: { type: "number", minimum: 0, maximum: 255 },
                brightness: { type: "number", minimum: 0, maximum: 100 },
                temperature: { type: "number", minimum: 0, maximum: 100 },
            },
            required: ["action"],
            additionalProperties: false,
        },
        capabilities: ["device.read", "device.control"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "accepted",
        serializeKey: () => "smart-home:light",
        responsePolicy: { deterministic: true },
        execute: async (input, context) => {
            const result = automationResult(await controlLight(input, context), input.action);
            result.speech = lightResponse(input, result);
            return result;
        },
    }));

    registry.register(define<TelevisionInput, AutomationPayload>({
        name: "control_tv",
        description: "Controla a televisão: energia, volume, mídia, canais, entrada, menu e navegação.",
        category: "smart-home",
        inputSchema: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: [
                        "on", "off", "toggle", "status", "volume_up", "volume_down",
                        "mute", "unmute", "play", "pause", "stop", "home", "back",
                        "up", "down", "left", "right", "select", "menu", "input",
                        "channel_up", "channel_down", "next", "previous", "pair",
                    ],
                },
            },
            required: ["action"],
            additionalProperties: false,
        },
        capabilities: ["device.read", "device.control"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "accepted",
        serializeKey: () => "smart-home:television",
        responsePolicy: { deterministic: true },
        execute: async (input, context) => {
            const result = automationResult(await controlTelevision(input.action, context), input.action);
            result.speech = televisionResponse(input, result);
            return result;
        },
    }));

    registry.register(define<HomeDeviceInput, AutomationPayload>({
        name: "control_home_device",
        description: "Controla um dispositivo residencial, como ventilador, tomada, cortina ou ar-condicionado.",
        category: "smart-home",
        inputSchema: {
            type: "object",
            properties: {
                device: { type: "string" },
                action: { type: "string", enum: ["on", "off", "toggle", "status", "open", "close"] },
            },
            required: ["device", "action"],
            additionalProperties: false,
        },
        capabilities: ["device.read", "device.control"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "accepted",
        serializeKey: input => `smart-home:${input.device.toLowerCase()}`,
        responsePolicy: { deterministic: true },
        execute: async (input, context) => {
            const result = automationResult(
                await controlHomeDevice(input.device, input.action, context),
                input.action,
            );
            result.speech = result.success && result.status === "confirmed"
                ? "Feito."
                : result.success
                    ? `Enviei o comando para ${input.device}.`
                    : result.message;
            return result;
        },
    }));

    registry.register(define<{ code: string }, AutomationPayload>({
        name: "pair_television",
        description: "Envia o PIN exibido pela Android TV para concluir o pareamento.",
        category: "smart-home",
        inputSchema: {
            type: "object",
            properties: { code: { type: "string", pattern: "^[A-Za-z0-9]{6}$" } },
            required: ["code"],
            additionalProperties: false,
        },
        capabilities: ["device.pair"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "confirmed",
        serializeKey: () => "smart-home:television",
        responsePolicy: { deterministic: true },
        execute: async (input, context) => {
            const result = automationResult(
                await submitTelevisionPairingCode(input.code, context),
                "pair",
            );
            result.speech = result.message;
            return result;
        },
    }));

    personalProviderRuntime = registerPersonalProviderTools(registry, {
        runtime: personalProviderRuntime,
    });
    registry.register(createDailyBriefingTool(personalProviderRuntime, {
        notificationPublisher: {
            async publish(notification, context) {
                await notificationCenter.publish({
                    title: notification.title,
                    message: notification.message,
                    source: "personal.dailyBriefing",
                    priority: "normal",
                    trust: notification.trust,
                    dedupeKey: `daily-briefing:${notification.generatedAt.slice(0, 10)}`,
                    metadata: {
                        generatedAt: notification.generatedAt,
                        eventsToday: notification.counts.eventsToday,
                        overdueTasks: notification.counts.overdueTasks,
                        tasksDueToday: notification.counts.tasksDueToday,
                        unreadEmails: notification.counts.unreadEmails,
                        importantEmails: notification.counts.importantEmails,
                        unavailableSources: notification.counts.unavailableSources,
                    },
                }, { signal: context?.signal });
            },
        },
    }));

    for (const tool of createObsidianTools(obsidianIndex)) registry.register(tool);
    return registry;
}

export const ultronToolRegistry = createCoreToolRegistry();

export function toolExecutionContext(context: ToolContext = {}): ToolContext {
    return context;
}
