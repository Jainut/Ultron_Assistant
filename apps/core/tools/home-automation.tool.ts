import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ActionStatus } from "../shared/types.ts";
import { runtimeConfig } from "../src/config/runtime.ts";
import {
    controlDiscoveredDevice,
    findDiscoveredDevice,
    findDiscoveredTelevision,
    isDiscoveredDeviceOnline,
} from "../src/automation/device-discovery.ts";
import {
    androidTvRemote,
    type AndroidTvCommandResult,
    type AndroidTvPairingResult,
} from "../src/automation/android-tv-remote.ts";
import type { ToolContext } from "../src/tools/tool.ts";

type PowerAction = "on" | "off" | "toggle" | "status" | "open" | "close";
export type TelevisionAction =
    | PowerAction
    | "volume_up"
    | "volume_down"
    | "mute"
    | "unmute"
    | "play"
    | "pause"
    | "stop"
    | "home"
    | "back"
    | "up"
    | "down"
    | "left"
    | "right"
    | "select"
    | "menu"
    | "input"
    | "channel_up"
    | "channel_down"
    | "next"
    | "previous"
    | "pair";

interface HomeAssistantConfig {
    url: string;
    token: string;
    entities: Record<string, string>;
}

interface TelevisionConfig {
    mac?: string;
    broadcast?: string;
    wolPort?: number;
}

interface HomeConfig {
    homeAssistant?: HomeAssistantConfig;
    television?: TelevisionConfig;
}

interface AutomationResult {
    success: boolean;
    message: string;
    device?: string;
    action?: string;
    state?: unknown;
    status?: ActionStatus;
    confirmed?: boolean;
}

const configPath = path.join(
    runtimeConfig.projectRoot,
    "config",
    "home.devices.json",
);

function normalize(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}

async function loadConfig(): Promise<HomeConfig> {
    try {
        return JSON.parse(await readFile(configPath, "utf8")) as HomeConfig;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return {};
        }

        throw error;
    }
}

function asResult(result: AutomationResult): string {
    return JSON.stringify(result);
}

export function formatAndroidTvResult(
    deviceName: string,
    action: TelevisionAction,
    state: AndroidTvCommandResult,
): string {
    let message = `Comando ${action} enviado para ${deviceName}.`;
    if (action === "status") {
        message = state.confirmed && typeof state.powered === "boolean"
            ? `${deviceName} informou que está ${state.powered ? "ligada" : "desligada"}.`
            : "A TV está acessível, mas ainda não confirmou o estado de energia.";
    } else if (action === "on" || action === "off") {
        message = state.confirmed
            ? `${deviceName} confirmou que está ${action === "on" ? "ligada" : "desligada"}.`
            : `Enviei o comando para ${action === "on" ? "ligar" : "desligar"}, mas a TV ainda não confirmou o estado.`;
    } else if (action === "toggle") {
        message = state.confirmed && typeof state.powered === "boolean"
            ? `${deviceName} informou que está ${state.powered ? "ligada" : "desligada"}.`
            : "Enviei o comando de energia para a TV; o estado ainda não foi confirmado.";
    }
    return asResult({ success: true, device: deviceName, action, state, status: state.status, confirmed: state.confirmed, message });
}

export function formatTelevisionPairingResult(state: AndroidTvPairingResult): string {
    if (!state.paired) {
        return asResult({ success: false, device: state.device, action: "pair", state, status: "failed", message: "O pareamento não foi concluído pela TV." });
    }

    let message = "TV pareada com o Ultron.";
    if (state.actionError) {
        message += ` O comando pendente não foi concluído: ${state.actionError}`;
    } else if (state.executedAction) {
        if (state.actionResult?.confirmed) {
            message += state.executedAction === "on"
                ? " A TV confirmou que está ligada."
                : state.executedAction === "off"
                    ? " A TV confirmou que está desligada."
                    : " A TV confirmou o resultado do comando pendente.";
        } else {
            message += " Enviei o comando pendente, mas o resultado ainda não foi confirmado pela TV.";
        }
    }
    if (state.pairingPersisted === false) {
        message += " Não consegui salvar o pareamento; ele pode ser necessário novamente após reiniciar.";
    }
    // Confirmation here is only for pairing. The pending command keeps its
    // own status in actionResult and may still be accepted/unknown/failed.
    return asResult({ success: true, device: state.device, action: "pair", state, status: "confirmed", confirmed: true, message });
}

async function homeAssistantRequest(
    config: HomeAssistantConfig,
    pathname: string,
    init?: RequestInit,
): Promise<unknown> {
    const baseUrl = config.url.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
            ...init?.headers,
        },
        signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(8_000)])
            : AbortSignal.timeout(8_000),
    });
    const body = await response.text();

    if (!response.ok) {
        throw new Error(`Home Assistant respondeu ${response.status}.`);
    }

    return body ? JSON.parse(body) as unknown : null;
}

export function homeAssistantResultMetadata(state: unknown, action: string): {
    confirmed: boolean; status: "confirmed" | "accepted" | "unknown";
} {
    const observed = state && typeof state === "object" && "state" in state
        ? (state as { state?: unknown }).state : undefined;
    const confirmed = action === "status" && typeof observed === "string"
        && observed.length > 0 && observed !== "unknown" && observed !== "unavailable";
    return { confirmed, status: confirmed ? "confirmed" : action === "status" ? "unknown" : "accepted" };
}

async function callHomeAssistant(
    config: HomeAssistantConfig,
    entityId: string,
    action: PowerAction | TelevisionAction,
    signal?: AbortSignal,
): Promise<unknown> {
    if (action === "status") {
        return homeAssistantRequest(config, `/api/states/${entityId}`, { signal });
    }

    const domain = entityId.split(".")[0];
    const services: Record<string, string> = {
        on: "turn_on",
        off: "turn_off",
        toggle: "toggle",
        volume_up: "volume_up",
        volume_down: "volume_down",
        mute: "volume_mute",
        unmute: "volume_mute",
        play: "media_play",
        pause: "media_pause",
        open: "open_cover",
        close: "close_cover",
    };
    const service = domain === "cover"
        ? services[action === "on" ? "open" : action === "off" ? "close" : action]
        : services[action];

    if (!service) {
        throw new Error(`Ação ${action} não é suportada por ${entityId}.`);
    }

    const body: Record<string, unknown> = { entity_id: entityId };

    if (action === "mute" || action === "unmute") {
        body.is_volume_muted = action === "mute";
    }

    return homeAssistantRequest(
        config,
        `/api/services/${domain}/${service}`,
        { method: "POST", body: JSON.stringify(body), signal },
    );
}

async function wakeOnLan(
    macAddress: string,
    broadcastAddress = "255.255.255.255",
    port = 9,
): Promise<void> {
    const octets = macAddress.split(/[:-]/).map((value) => Number.parseInt(value, 16));

    if (octets.length !== 6 || octets.some((value) => !Number.isInteger(value))) {
        throw new Error("MAC address da TV inválido.");
    }

    const mac = Buffer.from(octets);
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(mac)]);

    await new Promise<void>((resolve, reject) => {
        const socket = dgram.createSocket("udp4");
        socket.once("error", (error) => {
            socket.close();
            reject(error);
        });
        socket.bind(() => {
            socket.setBroadcast(true);
            socket.send(packet, port, broadcastAddress, (error) => {
                socket.close();
                error ? reject(error) : resolve();
            });
        });
    });
}

export async function controlTelevision(
    action: TelevisionAction,
    context: ToolContext = {},
): Promise<string> {
    try {
        context.signal?.throwIfAborted();
        const config = await loadConfig();
        const homeAssistant = config.homeAssistant;
        const entityId = homeAssistant?.entities.television;

        if (homeAssistant && entityId && action !== "pair") {
            const state = await callHomeAssistant(homeAssistant, entityId, action, context.signal);
            return asResult({
                success: true,
                device: "television",
                action,
                state,
                ...homeAssistantResultMetadata(state, action),
                message: `Comando ${action} enviado para a TV pelo Home Assistant.`,
            });
        }

        const discovered = await findDiscoveredTelevision();
        context.signal?.throwIfAborted();

        if (discovered) {
            if (action === "pair") {
                if (discovered.protocol !== "android-tv") {
                    throw new Error(`${discovered.name} não usa o pareamento Android TV.`);
                }

                const state = await androidTvRemote.beginPairing(discovered, context.signal);
                const pairingState = state as { paired?: boolean; pairingRequired?: boolean };
                const message = typeof state === "object" && state && "message" in state
                    ? String(state.message)
                    : `Pareamento iniciado com ${discovered.name}.`;
                return asResult({
                    success: pairingState.paired === true || pairingState.pairingRequired === true,
                    device: discovered.name,
                    action,
                    state,
                    status: pairingState.paired === true ? "confirmed" : pairingState.pairingRequired === true ? "accepted" : "unknown",
                    confirmed: pairingState.paired === true,
                    message,
                });
            }

            if (action === "on") {
                const online = await isDiscoveredDeviceOnline(discovered);

                if (online && discovered.protocol === "android-tv") {
                    const state = await controlDiscoveredDevice(
                        discovered,
                        "on",
                        context.signal,
                    ) as AndroidTvCommandResult;
                    return formatAndroidTvResult(discovered.name, action, state);
                }

                const mac = discovered.mac ?? config.television?.mac;

                if (mac) {
                    await wakeOnLan(
                        mac,
                        discovered.broadcast ?? config.television?.broadcast,
                        config.television?.wolPort,
                    );
                    return asResult({
                        success: false,
                        device: discovered.name,
                        action,
                        state: { wakeOnLanSent: true, confirmed: false },
                        message: "Enviei Wake-on-LAN, mas essa TV não confirmou que ligou.",
                    });
                }

                return asResult({
                    success: false,
                    device: discovered.name,
                    action,
                    message: "Essa TV não oferece um método disponível para ligá-la pela rede.",
                });
            }

            const state = await controlDiscoveredDevice(discovered, action, context.signal);
            if (discovered.protocol === "android-tv") {
                return formatAndroidTvResult(discovered.name, action, state as AndroidTvCommandResult);
            }
            return asResult({
                success: true,
                device: discovered.name,
                action,
                state,
                message: `Comando ${action} enviado para ${discovered.name}, encontrada automaticamente.`,
            });
        }

        if (action === "on" && config.television?.mac) {
            await wakeOnLan(
                config.television.mac,
                config.television.broadcast,
                config.television.wolPort,
            );
            return asResult({
                success: false,
                device: "television",
                action,
                state: { wakeOnLanSent: true, confirmed: false },
                message: "Enviei Wake-on-LAN, mas não consegui confirmar que a TV ligou.",
            });
        }

        return asResult({
            success: false,
            device: "television",
            action,
            message: "Nenhuma TV controlável foi encontrada automaticamente na rede local.",
        });
    } catch (error) {
        if (context.signal?.aborted) throw error;
        return asResult({
            success: false,
            device: "television",
            action,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function submitTelevisionPairingCode(
    code: string,
    context: ToolContext = {},
): Promise<string> {
    try {
        const state = await androidTvRemote.submitPairingCode(code, context.signal);
        return formatTelevisionPairingResult(state);
    } catch (error) {
        if (context.signal?.aborted) throw error;
        return asResult({
            success: false,
            device: "television",
            action: "pair",
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function controlHomeDevice(
    device: string,
    action: PowerAction,
    context: ToolContext = {},
): Promise<string> {
    try {
        context.signal?.throwIfAborted();
        const config = await loadConfig();
        const homeAssistant = config.homeAssistant;

        if (homeAssistant) {
            const normalizedDevice = normalize(device);
            const entityEntry = Object.entries(homeAssistant.entities)
                .find(([name]) => normalize(name) === normalizedDevice);

            if (entityEntry) {
                const state = await callHomeAssistant(homeAssistant, entityEntry[1], action, context.signal);
                return asResult({
                    success: true,
                    device,
                    action,
                    state,
                    ...homeAssistantResultMetadata(state, action),
                    message: `Comando ${action} enviado para ${device}.`,
                });
            }
        }

        const discovered = await findDiscoveredDevice(device);
        context.signal?.throwIfAborted();

        if (discovered) {
            const state = await controlDiscoveredDevice(discovered, action, context.signal);
            return asResult({
                success: true,
                device: discovered.name,
                action,
                state,
                message: `Comando ${action} enviado para ${discovered.name}, encontrado automaticamente.`,
            });
        }

        return asResult({
            success: false,
            device,
            action,
            message: `Não encontrei automaticamente um dispositivo chamado ${device} na rede local.`,
        });
    } catch (error) {
        if (context.signal?.aborted) throw error;
        return asResult({
            success: false,
            device,
            action,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
