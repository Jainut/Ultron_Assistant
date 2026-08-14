import dgram from "node:dgram";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { runtimeConfig } from "../src/config/runtime.ts";
import {
    controlDiscoveredDevice,
    findDiscoveredDevice,
    findDiscoveredTelevision,
} from "../src/automation/device-discovery.ts";

type PowerAction = "on" | "off" | "toggle" | "status" | "open" | "close";
export type TelevisionAction =
    | PowerAction
    | "volume_up"
    | "volume_down"
    | "mute"
    | "unmute"
    | "play"
    | "pause";

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
        signal: AbortSignal.timeout(8_000),
    });
    const body = await response.text();

    if (!response.ok) {
        throw new Error(`Home Assistant respondeu ${response.status}: ${body}`);
    }

    return body ? JSON.parse(body) as unknown : null;
}

async function callHomeAssistant(
    config: HomeAssistantConfig,
    entityId: string,
    action: PowerAction | TelevisionAction,
): Promise<unknown> {
    if (action === "status") {
        return homeAssistantRequest(config, `/api/states/${entityId}`);
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
        { method: "POST", body: JSON.stringify(body) },
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

export async function controlTelevision(action: TelevisionAction): Promise<string> {
    try {
        const config = await loadConfig();
        const homeAssistant = config.homeAssistant;
        const entityId = homeAssistant?.entities.television;

        if (homeAssistant && entityId) {
            const state = await callHomeAssistant(homeAssistant, entityId, action);
            return asResult({
                success: true,
                device: "television",
                action,
                state,
                message: `Comando ${action} enviado para a TV e confirmado pelo Home Assistant.`,
            });
        }

        if (action === "on" && config.television?.mac) {
            await wakeOnLan(
                config.television.mac,
                config.television.broadcast,
                config.television.wolPort,
            );
            return asResult({
                success: true,
                device: "television",
                action,
                message: "Sinal Wake-on-LAN enviado para a TV.",
            });
        }

        const discovered = await findDiscoveredTelevision();

        if (discovered) {
            if (action === "on" && discovered.mac) {
                await wakeOnLan(
                    discovered.mac,
                    discovered.broadcast,
                );
                return asResult({
                    success: true,
                    device: discovered.name,
                    action,
                    message: `TV ${discovered.name} encontrada automaticamente e acionada por Wake-on-LAN.`,
                });
            }

            const state = await controlDiscoveredDevice(discovered, action);
            return asResult({
                success: true,
                device: discovered.name,
                action,
                state,
                message: `Comando ${action} enviado para ${discovered.name}, encontrada automaticamente.`,
            });
        }

        return asResult({
            success: false,
            device: "television",
            action,
            message: "Nenhuma TV controlável foi encontrada automaticamente na rede local.",
        });
    } catch (error) {
        return asResult({
            success: false,
            device: "television",
            action,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function controlHomeDevice(
    device: string,
    action: PowerAction,
): Promise<string> {
    try {
        const config = await loadConfig();
        const homeAssistant = config.homeAssistant;

        if (homeAssistant) {
            const normalizedDevice = normalize(device);
            const entityEntry = Object.entries(homeAssistant.entities)
                .find(([name]) => normalize(name) === normalizedDevice);

            if (entityEntry) {
                const state = await callHomeAssistant(homeAssistant, entityEntry[1], action);
                return asResult({
                    success: true,
                    device,
                    action,
                    state,
                    message: `Comando ${action} confirmado para ${device}.`,
                });
            }
        }

        const discovered = await findDiscoveredDevice(device);

        if (discovered) {
            const state = await controlDiscoveredDevice(discovered, action);
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
        return asResult({
            success: false,
            device,
            action,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}
