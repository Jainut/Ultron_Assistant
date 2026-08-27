import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";

import { runtimeConfig } from "../config/runtime.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";
import { androidTvRemote, type AndroidTvAction } from "./android-tv-remote.ts";
import { tuyaHomeClient } from "./tuya-cloud-client.ts";

export type DiscoveredProtocol =
    | "roku"
    | "samsung"
    | "lg-webos"
    | "android-tv"
    | "google-cast"
    | "tuya-cloud"
    | "kasa"
    | "shelly"
    | "wled"
    | "upnp"
    | "network";

export type DiscoveredDeviceKind =
    | "television"
    | "media_player"
    | "light"
    | "switch"
    | "unknown";

export interface DiscoveredDevice {
    id: string;
    name: string;
    ip: string;
    mac?: string;
    broadcast?: string;
    kind: DiscoveredDeviceKind;
    protocol: DiscoveredProtocol;
    manufacturer?: string;
    model?: string;
    location?: string;
    authToken?: string;
    deviceId?: string;
    lastSeen: number;
    lastDiscovered?: number;
    lastReachable?: number;
    lastConfirmed?: number;
    online?: boolean | null;
    paired?: boolean | null;
    /** Historical successful control; merely identifying a protocol is not proof. */
    controllable?: boolean;
    addressConflict?: boolean;
    capabilities?: DeviceCapabilities;
}

export interface DeviceCapabilities {
    /** Actions supported by this adapter, not a claim of device authorization. */
    actions: string[];
    powerMode: "discrete" | "toggle" | "unknown";
    requiresPairing: boolean;
    generation?: number;
}

interface SsdpRecord {
    ip: string;
    headers: Record<string, string>;
}

interface MdnsRecord {
    name: string;
    type: number;
    target?: string;
    port?: number;
    ip?: string;
    values?: Record<string, string>;
}

const registryPath = path.join(
    runtimeConfig.projectRoot,
    "data",
    "discovered-devices.json",
);

const SCAN_INTERVAL_MS = 5 * 60_000;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const REACHABILITY_MAX_AGE_MS = 60_000;
const MAX_INVENTORY_DEVICES = 1_024;
const PROTOCOLS: DiscoveredProtocol[] = ["roku", "samsung", "lg-webos", "android-tv", "google-cast", "tuya-cloud", "kasa", "shelly", "wled", "upnp", "network"];
const KINDS: DiscoveredDeviceKind[] = ["television", "media_player", "light", "switch", "unknown"];

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = (): void => {
            signal.removeEventListener("abort", abort);
            reject(signal.reason ?? new DOMException("Operação cancelada.", "AbortError"));
        };
        promise.then(value => {
            signal.removeEventListener("abort", abort);
            resolve(value);
        }, error => {
            signal.removeEventListener("abort", abort);
            reject(error);
        });
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    });
}

export async function mapDiscoveryLimited<T, R>(
    values: readonly T[], concurrency: number,
    task: (value: T) => Promise<R>, signal?: AbortSignal,
): Promise<R[]> {
    const results: R[] = new Array(values.length);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
        while (cursor < values.length) {
            signal?.throwIfAborted();
            const index = cursor++;
            results[index] = await task(values[index]);
        }
    }));
    return results;
}

export function deviceCapabilities(device: Pick<DiscoveredDevice, "protocol" | "capabilities">): DeviceCapabilities {
    const power = ["status", "on", "off", "toggle"];
    const remote = [...power, "volume_up", "volume_down", "mute", "unmute", "play", "pause", "stop", "home", "back", "up", "down", "left", "right", "select", "channel_up", "channel_down", "next", "previous"];
    const actions = device.protocol === "android-tv" || device.protocol === "samsung"
        ? [...remote, "menu", "input"]
        : device.protocol === "roku" ? remote
            : ["kasa", "shelly", "wled", "tuya-cloud"].includes(device.protocol) ? power : [];
    return {
        actions,
        powerMode: device.protocol === "android-tv" ? "toggle" : actions.length ? "discrete" : "unknown",
        requiresPairing: ["android-tv", "samsung", "lg-webos"].includes(device.protocol),
        generation: device.protocol === "shelly" && Number.isInteger(device.capabilities?.generation)
            ? device.capabilities?.generation : undefined,
    };
}

function stableId(device: DiscoveredDevice): string | undefined {
    const id = device.id.trim().toLowerCase();
    if (!id || id.startsWith("network:") || /\d{1,3}(?:\.\d{1,3}){3}/.test(id)) return undefined;
    return id.startsWith("uuid:") ? id.split("::")[0] : id;
}

export function sameDeviceIdentity(left: DiscoveredDevice, right: DiscoveredDevice): boolean {
    const leftMac = normalizeMac(left.mac), rightMac = normalizeMac(right.mac);
    if (leftMac && rightMac && leftMac !== rightMac) return false;
    if (left.deviceId && right.deviceId && left.deviceId !== right.deviceId) return false;
    const leftId = stableId(left), rightId = stableId(right);
    if (left.protocol === right.protocol && leftId && rightId && leftId !== rightId) return false;
    return Boolean((leftMac && rightMac && leftMac === rightMac)
        || (left.deviceId && left.deviceId === right.deviceId)
        || (leftId && leftId === rightId));
}

function inventoryKey(device: DiscoveredDevice): string {
    return device.deviceId ? `device:${device.protocol}:${device.deviceId}`
        : normalizeMac(device.mac) ? `mac:${normalizeMac(device.mac)}`
            : stableId(device) ?? `endpoint:${device.protocol}:${device.ip}`;
}

function validTimestamp(value: unknown, now: number): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= now + 60_000 ? value : undefined;
}

export function parseDeviceInventory(raw: unknown, now = Date.now()): DiscoveredDevice[] {
    const entries = Array.isArray(raw) ? raw
        : raw && typeof raw === "object" && "version" in raw && raw.version === 2 && "devices" in raw && Array.isArray(raw.devices)
            ? raw.devices : [];
    return entries.slice(0, MAX_INVENTORY_DEVICES).flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as DiscoveredDevice;
        if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.ip !== "string"
            || !PROTOCOLS.includes(item.protocol) || !KINDS.includes(item.kind)) return [];
        if (!isPrivateIpv4(item.ip) && !(item.protocol === "tuya-cloud" && /^tuya:[\w-]+$/.test(item.ip))) return [];
        const lastSeen = validTimestamp(item.lastSeen, now);
        if (lastSeen === undefined || lastSeen < now - CACHE_MAX_AGE_MS) return [];
        const lastReachable = validTimestamp(item.lastReachable, now);
        return [{
            ...item,
            mac: normalizeMac(item.mac),
            deviceId: typeof item.deviceId === "string" ? item.deviceId : undefined,
            manufacturer: typeof item.manufacturer === "string" ? item.manufacturer : undefined,
            model: typeof item.model === "string" ? item.model : undefined,
            authToken: typeof item.authToken === "string" ? item.authToken : undefined,
            lastSeen,
            lastDiscovered: validTimestamp(item.lastDiscovered, now) ?? lastSeen,
            lastReachable,
            lastConfirmed: validTimestamp(item.lastConfirmed, now),
            online: item.online === false ? false : lastReachable !== undefined && now - lastReachable <= REACHABILITY_MAX_AGE_MS && item.online === true ? true : null,
            paired: typeof item.paired === "boolean" ? item.paired : null,
            controllable: item.controllable === true,
            addressConflict: item.addressConflict === true,
            capabilities: deviceCapabilities(item),
        }];
    });
}

export function mergeDeviceInventory(
    existingDevices: readonly DiscoveredDevice[], found: readonly DiscoveredDevice[], now = Date.now(),
): DiscoveredDevice[] {
    const merged = new Map(existingDevices.filter(device => device.lastSeen >= now - CACHE_MAX_AGE_MS).map(device => [inventoryKey(device), { ...device }]));
    for (const discovery of found) {
        const incoming = { ...discovery, mac: normalizeMac(discovery.mac), authToken: undefined };
        const prior = [...merged.values()].find(device => sameDeviceIdentity(device, incoming));
        const preferred = prior && deviceScore(prior) > deviceScore(incoming) ? prior : incoming;
        const sameProtocol = prior?.protocol === preferred.protocol;
        const device: DiscoveredDevice = {
            ...prior, ...preferred,
            ip: incoming.ip,
            mac: incoming.mac ?? prior?.mac,
            broadcast: incoming.broadcast ?? (prior?.ip === incoming.ip ? prior.broadcast : undefined),
            authToken: sameProtocol ? prior?.authToken : undefined,
            lastSeen: incoming.lastSeen,
            lastDiscovered: incoming.lastDiscovered ?? incoming.lastSeen,
            lastReachable: incoming.lastReachable ?? prior?.lastReachable,
            lastConfirmed: sameProtocol ? prior?.lastConfirmed : undefined,
            online: incoming.online ?? prior?.online ?? null,
            paired: sameProtocol ? prior?.paired ?? null : null,
            controllable: sameProtocol && prior?.controllable === true,
            addressConflict: false,
        };
        device.capabilities = deviceCapabilities(device);
        if (prior) merged.delete(inventoryKey(prior));
        for (const [key, previous] of merged) {
            if (previous.ip === incoming.ip && !sameDeviceIdentity(previous, incoming)) {
                if (key === inventoryKey(incoming)) merged.delete(key);
                else merged.set(key, { ...previous, online: false, addressConflict: true });
            }
        }
        merged.set(inventoryKey(device), device);
    }
    return [...merged.values()].sort((left, right) => right.lastSeen - left.lastSeen).slice(0, MAX_INVENTORY_DEVICES);
}

export async function writeDeviceInventoryAtomic(file: string, inventory: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, file);
    } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
    }
}

interface TuyaServiceResult {
    success?: boolean;
    error?: string;
    devices?: Array<{
        id: string;
        name: string;
        mac?: string;
        ip?: string;
        category?: string;
        model?: string;
        kind?: DiscoveredDeviceKind;
    }>;
    [key: string]: unknown;
}

async function runTuyaHomeService(args: string[], signal?: AbortSignal): Promise<TuyaServiceResult> {
    return JSON.parse(await tuyaHomeClient.request(args, signal)) as TuyaServiceResult;
}

function normalizeMac(mac: string | undefined): string | undefined {
    const compact = typeof mac === "string" ? mac.replace(/[^0-9a-f]/gi, "").toUpperCase() : undefined;
    return compact?.length === 12
        ? compact.match(/.{2}/g)?.join(":")
        : undefined;
}

async function discoverTuyaCloudDevices(signal?: AbortSignal): Promise<DiscoveredDevice[]> {
    try {
        const result = await runTuyaHomeService(["discover"], signal);

        return (result.devices ?? []).map(device => ({
            id: `tuya-cloud:${device.id}`,
            deviceId: device.id,
            name: device.name,
            ip: device.ip && isPrivateIpv4(device.ip)
                ? device.ip
                : `tuya:${device.id}`,
            mac: normalizeMac(device.mac),
            kind: device.kind ?? "unknown",
            protocol: "tuya-cloud",
            manufacturer: "Tuya",
            model: device.model ?? device.category,
            lastSeen: Date.now(),
        }));
    } catch (error) {
        if (signal?.aborted) throw error;
        debugLog("[DISCOVERY] Tuya Cloud indisponível:", error);
        return [];
    }
}

function normalize(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function isPrivateIpv4(ip: string): boolean {
    const parts = ip.split(".").map(Number);

    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }

    return parts[0] === 10
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168);
}

function decodeXml(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .trim();
}

function xmlValue(xml: string, tag: string): string | undefined {
    const match = xml.match(
        new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"),
    );

    return match ? decodeXml(match[1].replace(/<[^>]+>/g, "")) : undefined;
}

export function parseSsdpResponse(
    payload: string,
    ip: string,
): SsdpRecord | null {
    if (!payload.startsWith("HTTP/1.1 200")) {
        return null;
    }

    const headers: Record<string, string> = {};

    for (const line of payload.split(/\r?\n/).slice(1)) {
        const separator = line.indexOf(":");

        if (separator <= 0) {
            continue;
        }

        headers[line.slice(0, separator).trim().toLowerCase()] =
            line.slice(separator + 1).trim();
    }

    return { ip, headers };
}

export function parseArpTable(output: string): Map<string, string> {
    const entries = new Map<string, string>();

    for (const line of output.split(/\r?\n/)) {
        const match = line.match(
            /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+/i,
        );

        if (!match || !isPrivateIpv4(match[1])) {
            continue;
        }

        const mac = match[2].replace(/-/g, ":").toUpperCase();

        if (!mac.startsWith("FF:FF") && !mac.startsWith("01:00:5E")) {
            entries.set(match[1], mac);
        }
    }

    return entries;
}

function readArpTable(signal?: AbortSignal): Promise<Map<string, string>> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        execFile(
            "arp.exe",
            ["-a"],
            { windowsHide: true, timeout: 3_000, signal },
            (error, stdout) => {
                if (signal?.aborted) { reject(signal.reason); return; }
                resolve(error ? new Map() : parseArpTable(stdout));
            },
        );
    });
}

function ipv4ToNumber(ip: string): number {
    return ip.split(".").reduce(
        (result, part) => ((result << 8) | Number(part)) >>> 0,
        0,
    );
}

function numberToIpv4(value: number): string {
    return [24, 16, 8, 0]
        .map(shift => (value >>> shift) & 255)
        .join(".");
}

function broadcastFor(ip: string): string | undefined {
    const target = ipv4ToNumber(ip);

    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family !== "IPv4" || address.internal || !isPrivateIpv4(address.address)) {
                continue;
            }

            const local = ipv4ToNumber(address.address);
            const mask = ipv4ToNumber(address.netmask);

            if ((local & mask) === (target & mask)) {
                return numberToIpv4(((local & mask) | (~mask >>> 0)) >>> 0);
            }
        }
    }

    return undefined;
}

function discoverSsdp(timeoutMs = 1_200, signal?: AbortSignal): Promise<SsdpRecord[]> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const records = new Map<string, SsdpRecord>();
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const abort = (): void => finish(true);

        const finish = (cancelled = false): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            try { socket.close(); } catch { /* A cancelled socket may not be bound yet. */ }
            cancelled ? reject(signal?.reason) : resolve([...records.values()]);
        };

        socket.on("message", (message, remote) => {
            const record = parseSsdpResponse(message.toString("utf8"), remote.address);

            if (record && isPrivateIpv4(record.ip) && records.size < 256) {
                const key = record.headers.usn ?? `${record.ip}:${record.headers.location ?? ""}`;
                records.set(key, record);
            }
        });
        socket.once("error", () => finish());
        signal?.addEventListener("abort", abort, { once: true });
        socket.bind(0, () => {
            if (settled) return;
            const request = Buffer.from([
                "M-SEARCH * HTTP/1.1",
                "HOST: 239.255.255.250:1900",
                'MAN: "ssdp:discover"',
                "MX: 1",
                "ST: ssdp:all",
                "",
                "",
            ].join("\r\n"));

            socket.setMulticastTTL(2);
            socket.send(request, 1900, "239.255.255.250");
        });

        timer = setTimeout(finish, timeoutMs);
    });
}

function encodeDnsName(name: string): Buffer {
    const parts = name.split(".").filter(Boolean);
    return Buffer.concat([
        ...parts.map(part => {
            const content = Buffer.from(part, "utf8");
            return Buffer.concat([Buffer.from([content.length]), content]);
        }),
        Buffer.from([0]),
    ]);
}

function mdnsQuery(name: string): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4);
    const question = Buffer.alloc(4);
    question.writeUInt16BE(12, 0);
    // IN + bit de resposta unicast, para nao depender de ocupar a porta 5353.
    question.writeUInt16BE(0x8001, 2);
    return Buffer.concat([header, encodeDnsName(name), question]);
}

function readDnsName(
    packet: Buffer,
    initialOffset: number,
): { name: string; nextOffset: number } {
    const labels: string[] = [];
    let offset = initialOffset;
    let nextOffset = initialOffset;
    let jumped = false;
    let guard = 0;

    while (offset < packet.length && guard < 64) {
        guard += 1;
        const length = packet[offset];

        if (length === 0) {
            if (!jumped) {
                nextOffset = offset + 1;
            }
            break;
        }

        if ((length & 0xc0) === 0xc0) {
            if (offset + 1 >= packet.length) {
                break;
            }

            const pointer = ((length & 0x3f) << 8) | packet[offset + 1];

            if (!jumped) {
                nextOffset = offset + 2;
                jumped = true;
            }

            offset = pointer;
            continue;
        }

        const start = offset + 1;
        const end = start + length;

        if (end > packet.length) {
            break;
        }

        labels.push(packet.subarray(start, end).toString("utf8"));
        offset = end;

        if (!jumped) {
            nextOffset = offset;
        }
    }

    return { name: labels.join("."), nextOffset };
}

export function parseMdnsResponse(packet: Buffer): MdnsRecord[] {
    if (packet.length < 12) {
        return [];
    }

    const questionCount = packet.readUInt16BE(4);
    const recordCount = packet.readUInt16BE(6)
        + packet.readUInt16BE(8)
        + packet.readUInt16BE(10);
    let offset = 12;

    for (let index = 0; index < questionCount; index += 1) {
        const question = readDnsName(packet, offset);
        offset = question.nextOffset + 4;
    }

    const records: MdnsRecord[] = [];

    for (let index = 0; index < recordCount && offset + 10 <= packet.length; index += 1) {
        const decodedName = readDnsName(packet, offset);
        offset = decodedName.nextOffset;

        if (offset + 10 > packet.length) {
            break;
        }

        const type = packet.readUInt16BE(offset);
        const length = packet.readUInt16BE(offset + 8);
        const dataOffset = offset + 10;
        const dataEnd = dataOffset + length;
        offset = dataEnd;

        if (dataEnd > packet.length) {
            break;
        }

        const record: MdnsRecord = { name: decodedName.name, type };

        if (type === 1 && length === 4) {
            record.ip = [...packet.subarray(dataOffset, dataEnd)].join(".");
        } else if (type === 12) {
            record.target = readDnsName(packet, dataOffset).name;
        } else if (type === 33 && length >= 6) {
            record.port = packet.readUInt16BE(dataOffset + 4);
            record.target = readDnsName(packet, dataOffset + 6).name;
        } else if (type === 16) {
            const values: Record<string, string> = {};
            let cursor = dataOffset;

            while (cursor < dataEnd) {
                const itemLength = packet[cursor];
                const item = packet.subarray(cursor + 1, cursor + 1 + itemLength).toString("utf8");
                const separator = item.indexOf("=");
                values[separator >= 0 ? item.slice(0, separator) : item] =
                    separator >= 0 ? item.slice(separator + 1) : "";
                cursor += itemLength + 1;
            }

            record.values = values;
        }

        records.push(record);
    }

    return records;
}

function discoverMdns(timeoutMs = 1_000, signal?: AbortSignal): Promise<DiscoveredDevice[]> {
    signal?.throwIfAborted();
    const services = [
        "_googlecast._tcp.local",
        "_androidtvremote2._tcp.local",
        "_samsungmsf._tcp.local",
        "_roku-ecp._tcp.local",
        "_webostv._tcp.local",
        "_airplay._tcp.local",
        "_raop._tcp.local",
        "_hap._tcp.local",
        "_shelly._tcp.local",
        "_wled._tcp.local",
    ];

    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const records: MdnsRecord[] = [];
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const abort = (): void => finish(true);

        const finish = (cancelled = false): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            try { socket.close(); } catch { /* Cancelled before bind. */ }
            if (cancelled) { reject(signal?.reason); return; }
            const addresses = new Map(
                records
                    .filter(record => record.type === 1 && record.ip)
                    .map(record => [normalize(record.name), record.ip as string]),
            );
            const textByName = new Map(
                records
                    .filter(record => record.type === 16 && record.values)
                    .map(record => [normalize(record.name), record.values as Record<string, string>]),
            );
            const devices: DiscoveredDevice[] = [];

            for (const service of records.filter(record => record.type === 33 && record.target)) {
                const ip = addresses.get(normalize(service.target as string));

                if (!ip || !isPrivateIpv4(ip)) {
                    continue;
                }

                const values = textByName.get(normalize(service.name)) ?? {};
                const identity = `${service.name} ${values.fn ?? ""} ${values.md ?? ""}`;
                const protocol = protocolFromText(identity);
                const name = values.fn
                    ?? service.name.split("._")[0]
                    ?? `${protocol} ${ip}`;

                devices.push({
                    id: `mdns:${service.name}`,
                    name,
                    ip,
                    kind: kindFromText(identity),
                    protocol,
                    model: values.md,
                    lastSeen: Date.now(),
                });
            }

            resolve(devices);
        };

        socket.on("message", message => {
            if (records.length < 4_096) records.push(...parseMdnsResponse(message).slice(0, 4_096 - records.length));
        });
        socket.once("error", () => finish());
        signal?.addEventListener("abort", abort, { once: true });
        socket.bind(0, () => {
            if (settled) return;
            for (const service of services) {
                socket.send(mdnsQuery(service), 5353, "224.0.0.251");
            }
        });
        timer = setTimeout(finish, timeoutMs);
    });
}

async function isPortOpen(
    ip: string,
    port: number,
    timeoutMs = 250,
    signal?: AbortSignal,
): Promise<boolean> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: ip, port });
        let settled = false;
        const abort = (): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(signal?.reason);
        };

        const finish = (open: boolean): void => {
            if (settled) {
                return;
            }

            settled = true;
            signal?.removeEventListener("abort", abort);
            socket.destroy();
            resolve(open);
        };

        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(timeoutMs, () => finish(false));
        signal?.addEventListener("abort", abort, { once: true });
    });
}

async function fetchText(url: string, timeoutMs = 900, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    try {
        const response = await fetch(url, {
            signal: requestSignal(signal, timeoutMs),
            redirect: "error",
        });

        if (!response.ok || Number(response.headers.get("content-length")) > 1_048_576) return null;
        const text = await response.text();
        return text.length <= 1_048_576 ? text : null;
    } catch (error) {
        if (signal?.aborted) throw error;
        return null;
    }
}

function protocolFromText(value: string): DiscoveredProtocol {
    const text = normalize(value);

    if (text.includes("roku")) {
        return "roku";
    }

    if (text.includes("samsung")) {
        return "samsung";
    }

    if (text.includes("webos") || /\blg\b/.test(text)) {
        return "lg-webos";
    }

    if (text.includes("androidtv") || text.includes("android tv")) {
        return "android-tv";
    }

    if (text.includes("google") || text.includes("chromecast") || text.includes("cast")) {
        return "google-cast";
    }

    return "upnp";
}

function kindFromText(value: string): DiscoveredDeviceKind {
    const text = normalize(value);

    if (
        /\b(tv|television|televisor)\b/.test(text)
        || text.includes("roku")
        || text.includes("webos")
        || text.includes("samsung")
        || text.includes("androidtv")
    ) {
        return "television";
    }

    if (/\b(light|lamp|lampada|bulb|wled)\b/.test(text)) {
        return "light";
    }

    if (/\b(switch|plug|tomada|relay|shelly|kasa)\b/.test(text)) {
        return "switch";
    }

    if (/\b(media renderer|mediarenderer|speaker|cast)\b/.test(text)) {
        return "media_player";
    }

    return "unknown";
}

export function parseCastDeviceDescription(
    ip: string,
    description: string | null,
    androidRemoteAvailable: boolean,
): DiscoveredDevice | null {
    if (
        !androidRemoteAvailable
        && (!description || !/dial|google|cast/i.test(description))
    ) {
        return null;
    }

    const name = description ? xmlValue(description, "friendlyName") : undefined;
    const manufacturer = description ? xmlValue(description, "manufacturer") : undefined;
    const model = description ? xmlValue(description, "modelName") : undefined;
    const identity = `${name ?? ""} ${manufacturer ?? ""} ${model ?? ""} ${description ?? ""}`;

    return {
        id: `${androidRemoteAvailable ? "android-tv" : "google-cast"}:${ip}`,
        name: name ?? (androidRemoteAvailable ? "Android TV" : `Google Cast ${ip}`),
        ip,
        kind: androidRemoteAvailable ? "television" : kindFromText(identity),
        protocol: androidRemoteAvailable ? "android-tv" : "google-cast",
        manufacturer,
        model,
        location: description ? `http://${ip}:8008/ssdp/device-desc.xml` : undefined,
        lastSeen: Date.now(),
    };
}

async function enrichSsdpRecord(record: SsdpRecord, signal?: AbortSignal): Promise<DiscoveredDevice> {
    const location = record.headers.location;
    let safeLocation = false;
    try {
        const url = new URL(location);
        safeLocation = ["http:", "https:"].includes(url.protocol)
            && url.hostname === record.ip && isPrivateIpv4(url.hostname)
            && !url.username && !url.password;
    } catch { /* An untrusted advertisement is not an arbitrary fetch URL. */ }
    const description = safeLocation
        ? await fetchText(location, 900, signal)
        : null;
    const identity = [
        record.headers.server,
        record.headers.st,
        record.headers.usn,
        description,
    ].filter(Boolean).join(" ");
    const protocol = protocolFromText(identity);
    const manufacturer = description ? xmlValue(description, "manufacturer") : undefined;
    const model = description ? xmlValue(description, "modelName") : undefined;
    const name = (description ? xmlValue(description, "friendlyName") : undefined)
        ?? model
        ?? manufacturer
        ?? `${protocol} ${record.ip}`;

    return {
        id: record.headers.usn ?? `${protocol}:${record.ip}`,
        name,
        ip: record.ip,
        kind: kindFromText(`${name} ${manufacturer ?? ""} ${model ?? ""} ${identity}`),
        protocol,
        manufacturer,
        model,
        location,
        lastSeen: Date.now(),
    };
}

function kasaEncode(payload: string): Buffer {
    let key = 0xab;
    const content = Buffer.from(payload, "utf8");
    const packet = Buffer.alloc(content.length + 4);
    packet.writeUInt32BE(content.length, 0);

    for (let index = 0; index < content.length; index += 1) {
        const encrypted = content[index] ^ key;
        key = encrypted;
        packet[index + 4] = encrypted;
    }

    return packet;
}

function kasaDecode(payload: Buffer): string {
    let key = 0xab;
    const decoded = Buffer.alloc(payload.length);

    for (let index = 0; index < payload.length; index += 1) {
        const value = payload[index];
        decoded[index] = value ^ key;
        key = value;
    }

    return decoded.toString("utf8");
}

async function kasaRequest(
    ip: string,
    command: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: ip, port: 9999 });
        const chunks: Buffer[] = [];
        let expectedLength: number | null = null;
        let settled = false;
        const abort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new DOMException("Operação cancelada.", "AbortError"));

        const finish = (error?: Error, result?: Record<string, unknown>): void => {
            if (settled) {
                return;
            }

            settled = true;
            signal?.removeEventListener("abort", abort);
            socket.destroy();
            error ? reject(error) : resolve(result ?? {});
        };

        socket.once("connect", () => {
            socket.write(kasaEncode(JSON.stringify(command)));
        });
        socket.on("data", chunk => {
            chunks.push(chunk);
            const buffer = Buffer.concat(chunks);

            if (expectedLength === null && buffer.length >= 4) {
                expectedLength = buffer.readUInt32BE(0);
                if (expectedLength > 1_048_576) { finish(new Error("Resposta Kasa excedeu o limite permitido.")); return; }
            }

            if (expectedLength !== null && buffer.length >= expectedLength + 4) {
                try {
                    finish(
                        undefined,
                        JSON.parse(kasaDecode(buffer.subarray(4, expectedLength + 4))) as Record<string, unknown>,
                    );
                } catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
        socket.once("error", error => finish(error));
        socket.setTimeout(1_200, () => finish(new Error("Timeout Kasa")));
        signal?.addEventListener("abort", abort, { once: true });
    });
}

async function probeKnownProtocol(
    ip: string,
    signal?: AbortSignal,
): Promise<DiscoveredDevice | null> {
    const [roku, samsung, samsungSecure, lg, lgSecure, androidRemote, cast, kasa, http] = await Promise.all([
        ...[8060, 8001, 8002, 3000, 3001, 6466, 8008, 9999, 80].map(port => isPortOpen(ip, port, 250, signal)),
    ]);
    const now = Date.now();

    if (roku) {
        const info = await fetchText(`http://${ip}:8060/query/device-info`, 900, signal);
        return {
            id: `roku:${ip}`,
            name: info ? xmlValue(info, "friendly-device-name") ?? "Roku TV" : "Roku TV",
            ip,
            kind: "television",
            protocol: "roku",
            manufacturer: "Roku",
            model: info ? xmlValue(info, "model-name") : undefined,
            lastSeen: now,
        };
    }

    if (samsung || samsungSecure) {
        const infoText = await fetchText(`http://${ip}:8001/api/v2/`, 900, signal);
        let name = "Samsung TV";
        let model: string | undefined;

        if (infoText) {
            try {
                const info = JSON.parse(infoText) as {
                    device?: { name?: string; modelName?: string };
                };
                name = info.device?.name ?? name;
                model = info.device?.modelName;
            } catch {
                // O endpoint existe, mas alguns modelos retornam texto simples.
            }
        }

        return {
            id: `samsung:${ip}`,
            name,
            ip,
            kind: "television",
            protocol: "samsung",
            manufacturer: "Samsung",
            model,
            lastSeen: now,
        };
    }

    if (lg || lgSecure) {
        return {
            id: `lg-webos:${ip}`,
            name: "LG webOS TV",
            ip,
            kind: "television",
            protocol: "lg-webos",
            manufacturer: "LG",
            lastSeen: now,
        };
    }

    if (androidRemote || cast) {
        const description = cast
            ? await fetchText(`http://${ip}:8008/ssdp/device-desc.xml`, 900, signal)
            : null;
        const device = parseCastDeviceDescription(ip, description, androidRemote);
        if (device) return device;
    }

    if (kasa) {
        try {
            const response = await kasaRequest(ip, {
                system: { get_sysinfo: {} },
            }, signal);
            const system = response.system as {
                get_sysinfo?: Record<string, unknown>;
            } | undefined;
            const info = system?.get_sysinfo ?? {};
            const name = String(info.alias ?? info.dev_name ?? `Kasa ${ip}`);
            const model = String(info.model ?? "");

            return {
                id: `kasa:${String(info.deviceId ?? ip)}`,
                name,
                ip,
                kind: /bulb|light/i.test(`${name} ${model}`) ? "light" : "switch",
                protocol: "kasa",
                manufacturer: "TP-Link",
                model: model || undefined,
                lastSeen: now,
            };
        } catch (error) {
            if (signal?.aborted) throw error;
            // Portas 9999 de outros programas nao devem virar dispositivos Kasa.
        }
    }

    if (http) {
        const shellyText = await fetchText(`http://${ip}/shelly`, 600, signal);

        if (shellyText) {
            try {
                const info = JSON.parse(shellyText) as {
                    type?: string;
                    model?: string;
                    mac?: string;
                    gen?: number;
                };

                if (info.type || info.model || info.gen) {
                    return {
                        id: `shelly:${info.mac ?? ip}`,
                        name: info.model ?? info.type ?? `Shelly ${ip}`,
                        ip,
                        mac: info.mac,
                        kind: "switch",
                        protocol: "shelly",
                        manufacturer: "Shelly",
                        model: info.model ?? info.type,
                        lastSeen: now,
                        capabilities: { actions: [], powerMode: "discrete", requiresPairing: false, generation: info.gen ?? 1 },
                    };
                }
            } catch {
                // Nao era um endpoint Shelly.
            }
        }

        const wledText = await fetchText(`http://${ip}/json/info`, 600, signal);

        if (wledText) {
            try {
                const info = JSON.parse(wledText) as {
                    name?: string;
                    product?: string;
                    mac?: string;
                };

                if (info.name || info.product) {
                    return {
                        id: `wled:${info.mac ?? ip}`,
                        name: info.name ?? `WLED ${ip}`,
                        ip,
                        mac: info.mac,
                        kind: "light",
                        protocol: "wled",
                        manufacturer: "WLED",
                        model: info.product,
                        lastSeen: now,
                    };
                }
            } catch {
                // Nao era um endpoint WLED.
            }
        }
    }

    return null;
}

function deviceScore(device: DiscoveredDevice): number {
    const protocolScore: Record<DiscoveredProtocol, number> = {
        roku: 100,
        samsung: 90,
        "lg-webos": 80,
        "android-tv": 95,
        "tuya-cloud": 85,
        kasa: 75,
        shelly: 75,
        wled: 75,
        "google-cast": 60,
        upnp: 40,
        network: 10,
    };

    return protocolScore[device.protocol]
        + (device.mac ? 5 : 0)
        + (device.kind === "television" ? 5 : 0);
}

export interface DeviceScanContext {
    signal: AbortSignal;
    knownDevices: readonly DiscoveredDevice[];
    publish: (devices: readonly DiscoveredDevice[]) => void;
}

export interface DeviceRegistryOptions {
    filePath?: string;
    now?: () => number;
    readStore?: () => Promise<unknown>;
    writeStore?: (inventory: { version: 2; devices: DiscoveredDevice[] }) => Promise<void>;
    scan?: (context: DeviceScanContext) => Promise<void>;
    disabled?: () => boolean;
    scanTimeoutMs?: number;
    lookupWaitMs?: number;
    staleAfterMs?: number;
}

async function scanNetwork(context: DeviceScanContext): Promise<void> {
    const { signal, publish } = context;
    const knownIps = new Set<string>();
    let arp = new Map<string, string>();
    const publishLocal = (devices: readonly DiscoveredDevice[]): void => {
        const now = Date.now();
        publish(devices.map(device => ({
            ...device, mac: device.mac ?? arp.get(device.ip), broadcast: broadcastFor(device.ip),
            online: true, lastReachable: now,
        })));
        for (const device of devices) if (isPrivateIpv4(device.ip)) knownIps.add(device.ip);
    };
    const arpPromise = readArpTable(signal).then(entries => {
        arp = entries;
        const now = Date.now();
        publish([...entries].slice(0, 64).map(([ip, mac]) => ({
            id: `network:${mac}`, name: `Dispositivo ${ip}`, ip, mac,
            kind: "unknown", protocol: "network", lastSeen: now, online: null,
            broadcast: broadcastFor(ip),
        })));
        for (const ip of entries.keys()) knownIps.add(ip);
    });
    const mdnsPromise = discoverMdns(1_000, signal).then(publishLocal);
    const ssdpPromise = discoverSsdp(1_200, signal).then(records => mapDiscoveryLimited(
        records, 6, async record => {
            const device = await enrichSsdpRecord(record, signal);
            publishLocal([device]);
        }, signal,
    ));
    const cloudPromise = discoverTuyaCloudDevices(signal).then(devices => {
        const ipByMac = new Map([...arp].map(([ip, mac]) => [mac, ip]));
        publish(devices.map(device => ({ ...device, ip: (device.mac ? ipByMac.get(device.mac) : undefined) ?? device.ip })));
    });
    // Local batches are available before slow cloud discovery finishes.
    const probes = Promise.all([arpPromise, mdnsPromise, ssdpPromise]).then(() => {
        for (const device of context.knownDevices) if (isPrivateIpv4(device.ip)) knownIps.add(device.ip);
        return mapDiscoveryLimited([...knownIps].slice(0, 64), 6, async ip => {
            const device = await probeKnownProtocol(ip, signal);
            if (device) publishLocal([device]);
        }, signal);
    });
    await Promise.all([probes, cloudPromise]);
}

function matchesDeviceQuery(device: DiscoveredDevice, query: string): boolean {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return false;
    const identity = normalize([device.name, device.manufacturer, device.model, device.kind, device.protocol].filter(Boolean).join(" "));
    if (/\b(tv|televisao|televisor)\b/.test(normalizedQuery)) return device.kind === "television";
    if (normalizedQuery === "tomada") return device.kind === "switch";
    if (/\b(luz|lampada|iluminacao)\b/.test(normalizedQuery)) return device.kind === "light";
    return identity.includes(normalizedQuery) || (normalize(device.name).length > 0 && normalizedQuery.includes(normalize(device.name)));
}

export class DeviceRegistry {
    private devices: DiscoveredDevice[] = [];
    private loadPromise: Promise<void> | null = null;
    private scanPromise: Promise<DiscoveredDevice[]> | null = null;
    private scanController: AbortController | null = null;
    private lastScan = 0;
    private active = true;
    private writable = true;
    private generation = 0;
    private savePromise: Promise<void> = Promise.resolve();
    private readonly changes = new Set<() => void>();

    constructor(private readonly options: DeviceRegistryOptions = {}) {}

    private now(): number { return (this.options.now ?? Date.now)(); }
    private disabled(): boolean { return this.options.disabled?.() ?? (process.env.ULTRON_DISABLE_DISCOVERY === "1"); }

    start(): void {
        if (!this.active) this.lastScan = 0;
        this.active = true;
    }

    stop(): void {
        this.active = false;
        this.generation += 1;
        this.scanController?.abort(new DOMException("Descoberta encerrada.", "AbortError"));
        this.scanController = null;
        this.scanPromise = null;
    }

    private async load(): Promise<void> {
        if (!this.loadPromise) this.loadPromise = (async () => {
            try {
                const stored = this.options.readStore
                    ? await this.options.readStore()
                    : JSON.parse(await readFile(this.options.filePath ?? registryPath, "utf8")) as unknown;
                if (!Array.isArray(stored) && (!stored || typeof stored !== "object"
                    || !("version" in stored) || stored.version !== 2 || !("devices" in stored) || !Array.isArray(stored.devices))) {
                    throw new Error("Formato do inventário não suportado.");
                }
                this.devices = parseDeviceInventory(stored, this.now());
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    this.writable = false;
                    debugLog("[DISCOVERY] Inventário indisponível; será reconstruído.");
                }
                this.devices = [];
            }
        })();
        return this.loadPromise;
    }

    private async save(): Promise<void> {
        if (!this.writable) return;
        const inventory = { version: 2 as const, devices: structuredClone(this.devices) };
        const operation = this.savePromise.catch(() => undefined).then(() => this.options.writeStore
            ? this.options.writeStore(inventory)
            : writeDeviceInventoryAtomic(this.options.filePath ?? registryPath, inventory));
        this.savePromise = operation;
        await operation;
    }

    async list(): Promise<DiscoveredDevice[]> {
        await this.load();
        return parseDeviceInventory(this.devices, this.now()).sort((left, right) =>
            Number(Boolean(left.addressConflict)) - Number(Boolean(right.addressConflict))
            || Number(left.online === false) - Number(right.online === false)
            || deviceScore(right) - deviceScore(left));
    }

    async scan(force = false, signal?: AbortSignal): Promise<DiscoveredDevice[]> {
        signal?.throwIfAborted();
        const generation = this.generation;
        await this.load();
        signal?.throwIfAborted();
        if (!this.active || this.disabled() || generation !== this.generation) return this.list();
        if (this.scanPromise) return waitWithSignal(this.scanPromise, signal);
        if (!force && this.lastScan > 0 && this.now() - this.lastScan < 30_000) return this.list();
        this.lastScan = this.now();
        const controller = new AbortController();
        this.scanController = controller;
        const operation = this.performScan(controller, generation);
        this.scanPromise = operation;
        void operation.finally(() => {
            if (this.scanPromise === operation) this.scanPromise = null;
            if (this.scanController === controller) this.scanController = null;
        }).catch(() => undefined);
        return waitWithSignal(operation, signal);
    }

    private async performScan(controller: AbortController, generation: number): Promise<DiscoveredDevice[]> {
        debugLog("[DISCOVERY] Escaneando dispositivos da rede local.");
        const signal = requestSignal(controller.signal, this.options.scanTimeoutMs ?? 12_000);
        let changed = false;
        let accepting = true;
        const context: DeviceScanContext = {
            signal,
            knownDevices: structuredClone(this.devices),
            publish: devices => {
                if (!accepting || signal.aborted || generation !== this.generation || !this.active) return;
                const valid = parseDeviceInventory(devices, this.now());
                if (valid.length === 0) return;
                this.devices = mergeDeviceInventory(this.devices, valid, this.now());
                changed = true;
                for (const notify of this.changes) notify();
            },
        };
        try {
            await waitWithSignal((this.options.scan ?? scanNetwork)(context), signal);
        } catch (error) {
            if (controller.signal.aborted) throw error;
            debugLog("[DISCOVERY] Atualização parcial; mantendo o inventário disponível.");
        } finally {
            accepting = false;
            if (!controller.signal.aborted) controller.abort(new DOMException("Atualização de descoberta concluída.", "AbortError"));
            if (changed) await this.save().catch(() => debugLog("[DISCOVERY] Não foi possível persistir o inventário."));
        }
        return this.list();
    }

    private async waitForDevices(
        matches: (device: DiscoveredDevice) => boolean,
        operation: Promise<DiscoveredDevice[]>, budgetMs: number, signal?: AbortSignal,
    ): Promise<DiscoveredDevice[]> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const current = (): DiscoveredDevice[] => this.devices.filter(matches);
            const finish = (error?: unknown): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.changes.delete(updated);
                signal?.removeEventListener("abort", aborted);
                error === undefined ? resolve(current()) : reject(error);
            };
            const updated = (): void => { if (current().length) finish(); };
            const aborted = (): void => finish(signal?.reason);
            const timer = setTimeout(() => finish(), budgetMs);
            this.changes.add(updated);
            operation.then(() => finish(), error => finish(error));
            if (signal?.aborted) aborted();
            else signal?.addEventListener("abort", aborted, { once: true });
            updated();
        });
    }

    async find(query: string, signal?: AbortSignal): Promise<DiscoveredDevice[]> {
        signal?.throwIfAborted();
        if (!this.active || this.disabled() || !normalize(query)) return [];
        const devices = await this.list();
        signal?.throwIfAborted();
        const matches = (device: DiscoveredDevice): boolean => matchesDeviceQuery(device, query);
        const matching = devices.filter(matches);
        const stale = !this.lastScan || this.now() - this.lastScan >= (this.options.staleAfterMs ?? SCAN_INTERVAL_MS);
        if (matching.length) {
            if (stale) void this.scan().catch(() => undefined);
            return matching;
        }
        await this.waitForDevices(matches, this.scan(), this.options.lookupWaitMs ?? 1_500, signal);
        signal?.throwIfAborted();
        return (await this.list()).filter(matches);
    }

    async current(device: DiscoveredDevice): Promise<DiscoveredDevice> {
        await this.load();
        const exact = this.devices.find(item => sameDeviceIdentity(item, device));
        if (exact) return { ...exact };
        const occupant = this.devices.find(item => item.ip === device.ip);
        if (occupant && (occupant.id !== device.id || normalizeMac(occupant.mac) !== normalizeMac(device.mac))) {
            return { ...device, addressConflict: true, online: false };
        }
        return occupant ?? device;
    }

    async refreshIdentity(device: DiscoveredDevice, signal?: AbortSignal): Promise<DiscoveredDevice | null> {
        if (!normalizeMac(device.mac) && !device.deviceId && !stableId(device)) return null;
        const matches = (candidate: DiscoveredDevice): boolean => sameDeviceIdentity(candidate, device)
            && candidate.ip !== device.ip && !candidate.addressConflict;
        await this.waitForDevices(matches, this.scan(true), Math.min(this.options.lookupWaitMs ?? 1_500, 1_500), signal);
        return (await this.list()).find(matches) ?? null;
    }

    async recordOutcome(device: DiscoveredDevice, result?: unknown, failed = false): Promise<void> {
        await this.load();
        const target = this.devices.find(item => sameDeviceIdentity(item, device) && item.ip === device.ip);
        if (!target) return;
        target.online = !failed;
        if (!failed) {
            target.lastReachable = this.now();
            const outcome = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
            // A reachable status endpoint does not prove remote control authorization.
            if (outcome?.confirmed === true || outcome?.status === "accepted" || outcome?.optimistic === true) {
                target.controllable = true;
            }
            if (device.protocol === "android-tv") target.paired = true;
            if (outcome?.confirmed === true) {
                target.lastConfirmed = this.now();
            }
        }
        await this.save().catch(() => debugLog("[DISCOVERY] Atualização de estado não persistida."));
    }

    async saveToken(device: DiscoveredDevice, token: string): Promise<void> {
        await this.load();
        const target = this.devices.find(item => item.protocol === device.protocol && sameDeviceIdentity(item, device));
        if (!target) return;
        target.authToken = token;
        target.paired = true;
        await this.save();
    }
}

const registry = new DeviceRegistry();
let discoveryTimer: NodeJS.Timeout | null = null;

export function startAutomaticDeviceDiscovery(): void {
    if (process.env.ULTRON_DISABLE_DISCOVERY === "1" || discoveryTimer) {
        return;
    }

    registry.start();
    void registry.scan().catch(error => {
        debugLog("[DISCOVERY] Falha no scan inicial:", error);
    });
    discoveryTimer = setInterval(() => {
        void registry.scan(true).catch(error => {
            debugLog("[DISCOVERY] Falha ao atualizar dispositivos:", error);
        });
    }, SCAN_INTERVAL_MS);
    discoveryTimer.unref();
}

export function stopAutomaticDeviceDiscovery(): void {
    registry.stop();
    if (discoveryTimer) {
        clearInterval(discoveryTimer);
        discoveryTimer = null;
    }
}

export async function discoverDevices(force = false, signal?: AbortSignal): Promise<DiscoveredDevice[]> {
    signal?.throwIfAborted();
    if (!force) {
        const cached = await registry.list();
        if (cached.length) {
            void registry.scan().catch(() => undefined);
            return cached;
        }
    }
    return registry.scan(force, signal);
}

export async function isDiscoveredDeviceOnline(
    device: DiscoveredDevice,
    timeoutMs = 350,
    signal?: AbortSignal,
): Promise<boolean> {
    const ports: Partial<Record<DiscoveredProtocol, number[]>> = {
        roku: [8060],
        samsung: [8001, 8002],
        "lg-webos": [3000, 3001],
        "android-tv": [6466],
        "google-cast": [8008],
        kasa: [9999],
        shelly: [80],
        wled: [80],
    };
    const candidates = ports[device.protocol] ?? [];
    return (await Promise.all(
        candidates.map(port => isPortOpen(device.ip, port, timeoutMs, signal)),
    )).some(Boolean);
}

async function findDevices(query: string, signal?: AbortSignal): Promise<DiscoveredDevice[]> {
    return registry.find(query, signal);
}

export async function findDiscoveredTelevision(signal?: AbortSignal): Promise<DiscoveredDevice | null> {
    return (await findDevices("televisao", signal))[0] ?? null;
}

export async function findDiscoveredDevice(
    name: string,
    signal?: AbortSignal,
): Promise<DiscoveredDevice | null> {
    return (await findDevices(name, signal))[0] ?? null;
}

export interface DeviceControlAdapters {
    fetch?: typeof fetch;
    createWebSocket?: (url: string) => WebSocket;
    kasaRequest?: (ip: string, command: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
    androidControl?: (device: DiscoveredDevice, action: AndroidTvAction, signal?: AbortSignal) => Promise<unknown>;
    tuyaRequest?: (args: string[], signal?: AbortSignal) => Promise<TuyaServiceResult>;
    saveToken?: (device: DiscoveredDevice, token: string) => Promise<void>;
}

async function deviceHttp(
    url: string, init: RequestInit, timeoutMs: number, signal: AbortSignal | undefined,
    adapters: DeviceControlAdapters,
): Promise<Response> {
    signal?.throwIfAborted();
    const response = await (adapters.fetch ?? fetch)(url, {
        ...init, redirect: "error", signal: requestSignal(signal, timeoutMs),
    });
    if (!response.ok) throw new Error(`Dispositivo respondeu HTTP ${response.status}.`);
    return response;
}

async function rokuCommand(
    device: DiscoveredDevice, action: string, signal?: AbortSignal, adapters: DeviceControlAdapters = {},
): Promise<unknown> {
    if (action === "status") {
        const response = await deviceHttp(`http://${device.ip}:8060/query/device-info`, {}, 1_500, signal, adapters);
        return { online: true, deviceInfo: await response.text(), confirmed: false, status: "unknown" };
    }

    const keys: Record<string, string> = {
        on: "PowerOn",
        off: "PowerOff",
        toggle: "Power",
        volume_up: "VolumeUp",
        volume_down: "VolumeDown",
        mute: "VolumeMute",
        unmute: "VolumeMute",
        play: "Play",
        pause: "Play",
        stop: "Stop",
        home: "Home",
        back: "Back",
        up: "Up",
        down: "Down",
        left: "Left",
        right: "Right",
        select: "Select",
        channel_up: "ChannelUp",
        channel_down: "ChannelDown",
        next: "Fwd",
        previous: "Rev",
    };
    const key = keys[action];

    if (!key) {
        throw new Error(`Ação ${action} não suportada pela TV Roku.`);
    }

    await deviceHttp(`http://${device.ip}:8060/keypress/${key}`, { method: "POST" }, 2_000, signal, adapters);
    return { key, confirmed: false, status: "accepted" };
}

async function samsungCommand(
    device: DiscoveredDevice, action: string, signal?: AbortSignal, adapters: DeviceControlAdapters = {},
): Promise<unknown> {
    signal?.throwIfAborted();
    const keys: Record<string, string> = {
        on: "KEY_POWERON",
        off: "KEY_POWEROFF",
        toggle: "KEY_POWER",
        volume_up: "KEY_VOLUP",
        volume_down: "KEY_VOLDOWN",
        mute: "KEY_MUTE",
        unmute: "KEY_MUTE",
        play: "KEY_PLAY",
        pause: "KEY_PAUSE",
        stop: "KEY_STOP",
        home: "KEY_HOME",
        back: "KEY_RETURN",
        up: "KEY_UP",
        down: "KEY_DOWN",
        left: "KEY_LEFT",
        right: "KEY_RIGHT",
        select: "KEY_ENTER",
        menu: "KEY_MENU",
        input: "KEY_SOURCE",
        channel_up: "KEY_CHUP",
        channel_down: "KEY_CHDOWN",
        next: "KEY_FF",
        previous: "KEY_REWIND",
    };
    const key = keys[action];

    if (action === "status") {
        await deviceHttp(`http://${device.ip}:8001/api/v2/`, {}, 1_500, signal, adapters);
        return { online: true, confirmed: false, status: "unknown" };
    }

    if (!key) {
        throw new Error(`Ação ${action} não suportada pela TV Samsung.`);
    }

    return new Promise((resolve, reject) => {
        const name = Buffer.from("Ultron", "utf8").toString("base64");
        const token = device.authToken ? `&token=${encodeURIComponent(device.authToken)}` : "";
        const socket = (adapters.createWebSocket ?? (url => new WebSocket(url)))(
            `ws://${device.ip}:8001/api/v2/channels/samsung.remote.control?name=${encodeURIComponent(name)}${token}`,
        );
        let settled = false;
        let sent = false;
        let responseTimer: NodeJS.Timeout | undefined;
        const abort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new DOMException("Operação cancelada.", "AbortError"));
        const timeout = setTimeout(() => {
            finish(new Error("A TV não autorizou o Ultron. Aceite o pareamento exibido nela."));
        }, 10_000);

        const finish = (error?: Error, value?: unknown): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            clearTimeout(responseTimer);
            signal?.removeEventListener("abort", abort);
            try { socket.close(); } catch { /* Closing an interrupted handshake is best effort. */ }
            error ? reject(error) : resolve(value);
        };

        socket.onerror = () => finish(new Error("Não foi possível conectar ao controle Samsung."));
        socket.onclose = () => {
            if (!settled) finish(sent ? undefined : new Error("Conexão Samsung encerrada antes do comando."),
                sent ? { key, confirmed: false, status: "accepted" } : undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });
        socket.onmessage = event => {
            if (settled || signal?.aborted) return;
            try {
                const message = JSON.parse(String(event.data)) as {
                    event?: string;
                    data?: { token?: string };
                };

                if (message.event === "ms.channel.unauthorized") {
                    finish(new Error("Pareamento recusado pela TV Samsung."));
                    return;
                }

                if (message.event !== "ms.channel.connect" || sent) {
                    return;
                }

                if (message.data?.token) {
                    void (adapters.saveToken ?? ((target, value) => registry.saveToken(target, value)))(device, message.data.token)
                        .catch(() => debugLog("[DISCOVERY] Token Samsung não persistido."));
                }

                sent = true;
                socket.send(JSON.stringify({
                    method: "ms.remote.control",
                    params: {
                        Cmd: "Click",
                        DataOfCmd: key,
                        Option: "false",
                        TypeOfRemote: "SendRemoteKey",
                    },
                }));
                responseTimer = setTimeout(() => finish(undefined, { key, confirmed: false, status: "accepted" }), 250);
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        };
    });
}

function kasaPayload(response: Record<string, unknown>, operation: string): Record<string, unknown> {
    const system = response.system;
    const payload = system && typeof system === "object" ? (system as Record<string, unknown>)[operation] : undefined;
    if (!payload || typeof payload !== "object") throw new Error("O dispositivo Kasa retornou uma resposta incompleta.");
    const result = payload as Record<string, unknown>;
    if (result.err_code !== undefined && result.err_code !== 0) {
        throw new Error("O dispositivo Kasa recusou o comando.");
    }
    if (operation === "set_relay_state" && result.err_code !== 0) {
        throw new Error("O dispositivo Kasa não confirmou o recebimento do comando.");
    }
    return result;
}

const shellyGenerations = new Map<string, { generation: number; expires: number }>();

export async function executeDiscoveredDeviceCommand(
    device: DiscoveredDevice, action: string, signal?: AbortSignal, adapters: DeviceControlAdapters = {},
): Promise<unknown> {
    signal?.throwIfAborted();
    if (device.protocol !== "tuya-cloud" && !isPrivateIpv4(device.ip)) {
        throw new Error("O dispositivo não possui um endereço válido na rede local.");
    }
    if (!deviceCapabilities(device).actions.includes(action)) {
        throw new Error(device.name + " foi encontrado, mas não possui uma integração disponível para esse comando.");
    }
    if (device.protocol === "roku") return rokuCommand(device, action, signal, adapters);
    if (device.protocol === "samsung") return samsungCommand(device, action, signal, adapters);
    if (device.protocol === "android-tv") {
        return (adapters.androidControl ?? ((target, command, abort) => androidTvRemote.control(target, command, abort)))(
            device, action as AndroidTvAction, signal,
        );
    }

    if (device.protocol === "kasa") {
        const request = adapters.kasaRequest ?? kasaRequest;
        if (action === "status") {
            const response = await request(device.ip, { system: { get_sysinfo: {} } }, signal);
            const info = kasaPayload(response, "get_sysinfo");
            const confirmed = info.relay_state === 0 || info.relay_state === 1;
            return { ...response, confirmed, status: confirmed ? "confirmed" : "unknown",
                powered: confirmed ? info.relay_state === 1 : undefined };
        }
        let desiredState = action === "on" ? 1 : 0;
        if (action === "toggle") {
            const info = kasaPayload(await request(device.ip, { system: { get_sysinfo: {} } }, signal), "get_sysinfo");
            if (info.relay_state !== 0 && info.relay_state !== 1) {
                throw new Error("O dispositivo Kasa não informou o estado; não enviei toggle.");
            }
            desiredState = info.relay_state === 1 ? 0 : 1;
        }
        signal?.throwIfAborted();
        const response = await request(device.ip, { system: { set_relay_state: { state: desiredState } } }, signal);
        kasaPayload(response, "set_relay_state");
        return { ...response, confirmed: false, status: "accepted" };
    }

    if (device.protocol === "shelly") {
        const key = inventoryKey(device);
        const cached = shellyGenerations.get(key);
        let generation = device.capabilities?.generation
            ?? (cached && cached.expires > Date.now() ? cached.generation : undefined);
        if (generation === undefined) {
            const response = await deviceHttp("http://" + device.ip + "/shelly", {}, 800, signal, adapters);
            const info = await response.json() as { gen?: number; type?: string; model?: string };
            if (!info || (!info.gen && !info.type && !info.model)) throw new Error("O dispositivo não confirmou a identificação Shelly.");
            generation = info.gen ?? 1;
            shellyGenerations.set(key, { generation, expires: Date.now() + 60 * 60_000 });
            if (shellyGenerations.size > MAX_INVENTORY_DEVICES) shellyGenerations.delete(shellyGenerations.keys().next().value!);
        }
        const endpoint = generation >= 2
            ? action === "status" ? "/rpc/Switch.GetStatus?id=0"
                : action === "toggle" ? "/rpc/Switch.Toggle?id=0"
                    : "/rpc/Switch.Set?id=0&on=" + (action === "on")
            : action === "status" ? "/relay/0" : "/relay/0?turn=" + action;
        const response = await deviceHttp("http://" + device.ip + endpoint, {}, 1_500, signal, adapters);
        const payload = await response.json() as Record<string, unknown>;
        if (!payload || typeof payload !== "object" || payload.error || (typeof payload.code === "number" && payload.code !== 0)) {
            throw new Error("O dispositivo Shelly recusou o comando.");
        }
        if (action === "status") {
            const powered = generation >= 2 ? payload.output : payload.ison;
            const confirmed = typeof powered === "boolean";
            return { ...payload, powered: confirmed ? powered : undefined, confirmed, status: confirmed ? "confirmed" : "unknown" };
        }
        // Gen2 was_on describes the PREVIOUS state, not confirmation of the new one.
        const acknowledgement = generation >= 2 ? payload.was_on : payload.ison;
        if (typeof acknowledgement !== "boolean") throw new Error("O dispositivo Shelly não confirmou o recebimento do comando.");
        return { ...payload, confirmed: false, status: "accepted" };
    }

    if (device.protocol === "wled") {
        if (action === "status") {
            const response = await deviceHttp("http://" + device.ip + "/json/state", {}, 1_500, signal, adapters);
            const state = await response.json() as Record<string, unknown>;
            if (!state || typeof state !== "object") throw new Error("Estado WLED inválido.");
            const confirmed = typeof state.on === "boolean";
            return { ...state, powered: confirmed ? state.on : undefined, confirmed, status: confirmed ? "confirmed" : "unknown" };
        }
        const response = await deviceHttp("http://" + device.ip + "/json/state", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(action === "toggle" ? { on: "t" } : { on: action === "on" }),
        }, 1_500, signal, adapters);
        const result = await response.json() as Record<string, unknown>;
        if (!result || typeof result !== "object" || result.error || result.success === false) throw new Error("O WLED recusou o comando.");
        return { ...result, confirmed: false, status: "accepted" };
    }

    if (device.protocol === "tuya-cloud") {
        if (!device.deviceId) throw new Error("O dispositivo Tuya foi descoberto sem identificador válido.");
        const result = await (adapters.tuyaRequest ?? runTuyaHomeService)(["control", device.deviceId, action], signal);
        if (result.success !== true) throw new Error("O dispositivo Tuya recusou o comando.");
        return result;
    }
    throw new Error(device.name + " foi encontrado, mas não possui integração de controle disponível.");
}

export function isSafeDiscoveryRetry(device: DiscoveredDevice, action: string): boolean {
    if (action === "status") return true;
    return (action === "on" || action === "off")
        && ["roku", "kasa", "shelly", "wled", "tuya-cloud"].includes(device.protocol);
}

function isTransportFailure(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const failure = error as { code?: string; name?: string; cause?: unknown; message?: string };
    if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ENOTFOUND"].includes(failure.code ?? "")) return true;
    if (failure.name === "TimeoutError" || /timeout|não foi possível conectar|conexão .*encerrada|demorou demais para responder|\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT)\b/i.test(failure.message ?? "")) return true;
    return failure.cause !== error && isTransportFailure(failure.cause);
}

export interface DiscoveredDeviceControlOptions {
    registry?: Pick<DeviceRegistry, "current" | "refreshIdentity" | "recordOutcome">;
    adapters?: DeviceControlAdapters;
    execute?: (device: DiscoveredDevice, action: string, signal?: AbortSignal) => Promise<unknown>;
}

export async function controlDiscoveredDevice(
    device: DiscoveredDevice, action: string, signal?: AbortSignal, options: DiscoveredDeviceControlOptions = {},
): Promise<unknown> {
    signal?.throwIfAborted();
    const inventory = options.registry ?? registry;
    const lookupStart = performance.now();
    let current = await inventory.current(device);
    perf.record("Device lookup", performance.now() - lookupStart);
    signal?.throwIfAborted();
    if (current.addressConflict && current.protocol !== "tuya-cloud") {
        const recovered = await inventory.refreshIdentity(current, signal);
        if (!recovered || recovered.addressConflict || !sameDeviceIdentity(current, recovered)) {
            throw new Error("O IP salvo pertence a outro dispositivo. Não enviei o comando.");
        }
        current = recovered;
    }
    const execute = options.execute ?? ((target, command, abort) => executeDiscoveredDeviceCommand(target, command, abort, options.adapters));
    const run = async (target: DiscoveredDevice): Promise<unknown> => {
        signal?.throwIfAborted();
        const result = await perf.measure("Device command", () => execute(target, action, signal));
        void inventory.recordOutcome(target, result).catch(() => undefined);
        return result;
    };
    try {
        return await run(current);
    } catch (error) {
        if (signal?.aborted || !isTransportFailure(error)) throw error;
        void inventory.recordOutcome(current, undefined, true).catch(() => undefined);
        if (!isSafeDiscoveryRetry(current, action)) {
            // Refresh may help the NEXT explicit request, but never replay a toggle.
            void inventory.refreshIdentity(current, signal).catch(() => undefined);
            throw error;
        }
        const recovered = await inventory.refreshIdentity(current, signal);
        signal?.throwIfAborted();
        if (!recovered || recovered.addressConflict || recovered.ip === current.ip || !sameDeviceIdentity(current, recovered)) throw error;
        return run(recovered);
    }
}
