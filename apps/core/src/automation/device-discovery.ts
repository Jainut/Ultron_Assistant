import { execFile, spawn } from "node:child_process";
import dgram from "node:dgram";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";

import { runtimeConfig, servicePath } from "../config/runtime.ts";
import { debugLog } from "../utils/debug.ts";

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

function runTuyaHomeService(args: string[]): Promise<TuyaServiceResult> {
    return new Promise((resolve, reject) => {
        const serviceDir = servicePath("light-tuya");
        const child = spawn(
            path.join(serviceDir, ".venv", "Scripts", "python.exe"),
            [path.join(serviceDir, "src", "home_service.py"), ...args],
            { cwd: serviceDir, windowsHide: true },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error?: Error, result?: TuyaServiceResult): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            error ? reject(error) : resolve(result ?? {});
        };
        const timeout = setTimeout(() => {
            child.kill();
            finish(new Error("Timeout ao consultar dispositivos Tuya."));
        }, 15_000);

        child.stdout.on("data", chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });
        child.once("error", error => {
            finish(error);
        });
        child.once("close", code => {
            if (settled) {
                return;
            }

            try {
                const result = JSON.parse(stdout.trim()) as TuyaServiceResult;

                if (code !== 0 || result.success === false) {
                    finish(new Error(result.error ?? stderr.trim() ?? "Falha no serviço Tuya."));
                    return;
                }

                finish(undefined, result);
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
}

function normalizeMac(mac: string | undefined): string | undefined {
    const compact = mac?.replace(/[^0-9a-f]/gi, "").toUpperCase();
    return compact?.length === 12
        ? compact.match(/.{2}/g)?.join(":")
        : undefined;
}

async function discoverTuyaCloudDevices(): Promise<DiscoveredDevice[]> {
    try {
        const result = await runTuyaHomeService(["discover"]);

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

    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
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

function readArpTable(): Promise<Map<string, string>> {
    return new Promise(resolve => {
        execFile(
            "arp.exe",
            ["-a"],
            { windowsHide: true, timeout: 3_000 },
            (error, stdout) => {
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

function discoverSsdp(timeoutMs = 1_200): Promise<SsdpRecord[]> {
    return new Promise(resolve => {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const records = new Map<string, SsdpRecord>();
        let settled = false;

        const finish = (): void => {
            if (settled) {
                return;
            }

            settled = true;
            socket.close();
            resolve([...records.values()]);
        };

        socket.on("message", (message, remote) => {
            const record = parseSsdpResponse(message.toString("utf8"), remote.address);

            if (record && isPrivateIpv4(record.ip)) {
                const key = record.headers.usn ?? `${record.ip}:${record.headers.location ?? ""}`;
                records.set(key, record);
            }
        });
        socket.once("error", finish);
        socket.bind(0, () => {
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

        setTimeout(finish, timeoutMs);
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

function discoverMdns(timeoutMs = 1_000): Promise<DiscoveredDevice[]> {
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

    return new Promise(resolve => {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const records: MdnsRecord[] = [];
        let settled = false;

        const finish = (): void => {
            if (settled) {
                return;
            }

            settled = true;
            socket.close();
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
            records.push(...parseMdnsResponse(message));
        });
        socket.once("error", finish);
        socket.bind(0, () => {
            for (const service of services) {
                socket.send(mdnsQuery(service), 5353, "224.0.0.251");
            }
        });
        setTimeout(finish, timeoutMs);
    });
}

async function isPortOpen(
    ip: string,
    port: number,
    timeoutMs = 250,
): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.createConnection({ host: ip, port });
        let settled = false;

        const finish = (open: boolean): void => {
            if (settled) {
                return;
            }

            settled = true;
            socket.destroy();
            resolve(open);
        };

        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.setTimeout(timeoutMs, () => finish(false));
    });
}

async function fetchText(url: string, timeoutMs = 900): Promise<string | null> {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
        });

        return response.ok ? await response.text() : null;
    } catch {
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

async function enrichSsdpRecord(record: SsdpRecord): Promise<DiscoveredDevice> {
    const location = record.headers.location;
    const description = location && /^https?:\/\//i.test(location)
        ? await fetchText(location)
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
): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: ip, port: 9999 });
        const chunks: Buffer[] = [];
        let expectedLength: number | null = null;
        let settled = false;

        const finish = (error?: Error, result?: Record<string, unknown>): void => {
            if (settled) {
                return;
            }

            settled = true;
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
    });
}

async function probeKnownProtocol(
    ip: string,
): Promise<DiscoveredDevice | null> {
    const [roku, samsung, lg, kasa, http] = await Promise.all([
        isPortOpen(ip, 8060),
        isPortOpen(ip, 8001),
        isPortOpen(ip, 3000),
        isPortOpen(ip, 9999),
        isPortOpen(ip, 80),
    ]);
    const now = Date.now();

    if (roku) {
        const info = await fetchText(`http://${ip}:8060/query/device-info`);
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

    if (samsung) {
        const infoText = await fetchText(`http://${ip}:8001/api/v2/`);
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

    if (lg) {
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

    if (kasa) {
        try {
            const response = await kasaRequest(ip, {
                system: { get_sysinfo: {} },
            });
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
        } catch {
            // Portas 9999 de outros programas nao devem virar dispositivos Kasa.
        }
    }

    if (http) {
        const shellyText = await fetchText(`http://${ip}/shelly`, 600);

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
                    };
                }
            } catch {
                // Nao era um endpoint Shelly.
            }
        }

        const wledText = await fetchText(`http://${ip}/json/info`, 600);

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
        "android-tv": 70,
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

class DeviceRegistry {
    private devices: DiscoveredDevice[] = [];
    private loaded = false;
    private scanPromise: Promise<DiscoveredDevice[]> | null = null;
    private lastScan = 0;

    private async load(): Promise<void> {
        if (this.loaded) {
            return;
        }

        this.loaded = true;

        try {
            const stored = JSON.parse(
                await readFile(registryPath, "utf8"),
            ) as DiscoveredDevice[];
            const cutoff = Date.now() - CACHE_MAX_AGE_MS;
            this.devices = stored.filter(device => device.lastSeen >= cutoff);
        } catch {
            this.devices = [];
        }
    }

    private async save(): Promise<void> {
        await mkdir(path.dirname(registryPath), { recursive: true });
        await writeFile(
            registryPath,
            `${JSON.stringify(this.devices, null, 2)}\n`,
            "utf8",
        );
    }

    async list(): Promise<DiscoveredDevice[]> {
        await this.load();
        return [...this.devices].sort((left, right) => deviceScore(right) - deviceScore(left));
    }

    async scan(force = false): Promise<DiscoveredDevice[]> {
        await this.load();

        if (process.env.ULTRON_DISABLE_DISCOVERY === "1") {
            return this.list();
        }

        if (!force && Date.now() - this.lastScan < 30_000) {
            return this.list();
        }

        if (this.scanPromise) {
            return this.scanPromise;
        }

        this.scanPromise = this.performScan();

        try {
            return await this.scanPromise;
        } finally {
            this.scanPromise = null;
        }
    }

    private async performScan(): Promise<DiscoveredDevice[]> {
        debugLog("[DISCOVERY] Escaneando dispositivos da rede local.");
        const [ssdpRecords, mdnsDevices, arpEntries, tuyaDevices] = await Promise.all([
            discoverSsdp(),
            discoverMdns(),
            readArpTable(),
            discoverTuyaCloudDevices(),
        ]);
        const ssdpDevices = await Promise.all(ssdpRecords.map(enrichSsdpRecord));
        const arpIpByMac = new Map(
            [...arpEntries].map(([ip, mac]) => [mac, ip]),
        );

        for (const device of tuyaDevices) {
            const localIp = device.mac ? arpIpByMac.get(device.mac) : undefined;

            if (localIp) {
                device.ip = localIp;
            }
        }

        const knownIps = new Set([
            ...arpEntries.keys(),
            ...ssdpDevices.map(device => device.ip),
            ...mdnsDevices.map(device => device.ip),
        ]);
        const probed = await Promise.all(
            [...knownIps].slice(0, 64).map(probeKnownProtocol),
        );
        const found = [...ssdpDevices, ...mdnsDevices, ...tuyaDevices, ...probed.filter(
            (device): device is DiscoveredDevice => device !== null,
        )];
        const existingByIp = new Map(this.devices.map(device => [device.ip, device]));
        const mergedByIp = new Map<string, DiscoveredDevice>();

        for (const discovered of found) {
            const existing = existingByIp.get(discovered.ip);
            const mac = arpEntries.get(discovered.ip) ?? discovered.mac ?? existing?.mac;
            const preferred = existing && deviceScore(existing) > deviceScore(discovered)
                ? existing
                : discovered;

            mergedByIp.set(discovered.ip, {
                ...existing,
                ...preferred,
                mac,
                broadcast: isPrivateIpv4(discovered.ip)
                    ? broadcastFor(discovered.ip) ?? existing?.broadcast
                    : existing?.broadcast,
                authToken: existing?.authToken,
                lastSeen: Date.now(),
            });
        }

        for (const [ip, mac] of arpEntries) {
            if (mergedByIp.has(ip)) {
                continue;
            }

            const existing = existingByIp.get(ip);
            mergedByIp.set(ip, existing
                ? {
                    ...existing,
                    mac,
                    broadcast: broadcastFor(ip) ?? existing.broadcast,
                    lastSeen: Date.now(),
                }
                : {
                    id: `network:${mac}`,
                    name: `Dispositivo ${ip}`,
                    ip,
                    mac,
                    broadcast: broadcastFor(ip),
                    kind: "unknown",
                    protocol: "network",
                    lastSeen: Date.now(),
                });
        }

        const cutoff = Date.now() - CACHE_MAX_AGE_MS;

        for (const existing of this.devices) {
            if (!mergedByIp.has(existing.ip) && existing.lastSeen >= cutoff) {
                mergedByIp.set(existing.ip, existing);
            }
        }

        this.devices = [...mergedByIp.values()];
        this.lastScan = Date.now();
        await this.save();
        debugLog(`[DISCOVERY] ${found.length} dispositivo(s) identificado(s).`);
        return this.list();
    }

    async saveToken(ip: string, token: string): Promise<void> {
        await this.load();
        const device = this.devices.find(item => item.ip === ip);

        if (device) {
            device.authToken = token;
            await this.save();
        }
    }
}

const registry = new DeviceRegistry();
let discoveryTimer: NodeJS.Timeout | null = null;

export function startAutomaticDeviceDiscovery(): void {
    if (process.env.ULTRON_DISABLE_DISCOVERY === "1" || discoveryTimer) {
        return;
    }

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
    if (discoveryTimer) {
        clearInterval(discoveryTimer);
        discoveryTimer = null;
    }
}

export async function discoverDevices(force = false): Promise<DiscoveredDevice[]> {
    return registry.scan(force);
}

async function findDevices(query: string): Promise<DiscoveredDevice[]> {
    let devices = await registry.list();
    const normalizedQuery = normalize(query);
    const matchesDevice = (device: DiscoveredDevice): boolean => {
        const identity = normalize([
            device.name,
            device.manufacturer,
            device.model,
            device.kind,
            device.protocol,
        ].filter(Boolean).join(" "));

        if (/\b(tv|televisao|televisor)\b/.test(normalizedQuery)) {
            return device.kind === "television";
        }

        if (normalizedQuery === "tomada") {
            return device.kind === "switch";
        }

        if (/\b(luz|lampada|iluminacao)\b/.test(normalizedQuery)) {
            return device.kind === "light";
        }

        return identity.includes(normalizedQuery)
            || normalizedQuery.includes(normalize(device.name));
    };
    let matching = devices.filter(matchesDevice);

    if (matching.length === 0) {
        devices = await registry.scan(true);
        matching = devices.filter(matchesDevice);
    }

    return matching.sort((left, right) => deviceScore(right) - deviceScore(left));
}

export async function findDiscoveredTelevision(): Promise<DiscoveredDevice | null> {
    return (await findDevices("televisao"))[0] ?? null;
}

export async function findDiscoveredDevice(
    name: string,
): Promise<DiscoveredDevice | null> {
    return (await findDevices(name))[0] ?? null;
}

async function rokuCommand(device: DiscoveredDevice, action: string): Promise<unknown> {
    if (action === "status") {
        return fetchText(`http://${device.ip}:8060/query/device-info`, 1_500);
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
    };
    const key = keys[action];

    if (!key) {
        throw new Error(`Ação ${action} não suportada pela TV Roku.`);
    }

    const response = await fetch(`http://${device.ip}:8060/keypress/${key}`, {
        method: "POST",
        signal: AbortSignal.timeout(2_000),
    });

    if (!response.ok) {
        throw new Error(`Roku respondeu ${response.status}.`);
    }

    return { key };
}

async function samsungCommand(device: DiscoveredDevice, action: string): Promise<unknown> {
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
    };
    const key = keys[action];

    if (action === "status") {
        const response = await fetchText(`http://${device.ip}:8001/api/v2/`, 1_500);
        return { online: response !== null };
    }

    if (!key) {
        throw new Error(`Ação ${action} não suportada pela TV Samsung.`);
    }

    return new Promise((resolve, reject) => {
        const name = Buffer.from("Ultron", "utf8").toString("base64");
        const token = device.authToken ? `&token=${encodeURIComponent(device.authToken)}` : "";
        const socket = new WebSocket(
            `ws://${device.ip}:8001/api/v2/channels/samsung.remote.control?name=${encodeURIComponent(name)}${token}`,
        );
        let settled = false;
        const timeout = setTimeout(() => {
            finish(new Error("A TV não autorizou o Ultron. Aceite o pareamento exibido nela."));
        }, 10_000);

        const finish = (error?: Error, value?: unknown): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            socket.close();
            error ? reject(error) : resolve(value);
        };

        socket.onerror = () => finish(new Error("Não foi possível conectar ao controle Samsung."));
        socket.onmessage = event => {
            try {
                const message = JSON.parse(String(event.data)) as {
                    event?: string;
                    data?: { token?: string };
                };

                if (message.event === "ms.channel.unauthorized") {
                    finish(new Error("Pareamento recusado pela TV Samsung."));
                    return;
                }

                if (message.event !== "ms.channel.connect") {
                    return;
                }

                if (message.data?.token) {
                    void registry.saveToken(device.ip, message.data.token);
                }

                socket.send(JSON.stringify({
                    method: "ms.remote.control",
                    params: {
                        Cmd: "Click",
                        DataOfCmd: key,
                        Option: "false",
                        TypeOfRemote: "SendRemoteKey",
                    },
                }));
                setTimeout(() => finish(undefined, { key }), 250);
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        };
    });
}

export async function controlDiscoveredDevice(
    device: DiscoveredDevice,
    action: string,
): Promise<unknown> {
    if (device.protocol === "roku") {
        return rokuCommand(device, action);
    }

    if (device.protocol === "samsung") {
        return samsungCommand(device, action);
    }

    if (device.protocol === "kasa") {
        if (action === "status") {
            return kasaRequest(device.ip, { system: { get_sysinfo: {} } });
        }

        if (action !== "on" && action !== "off" && action !== "toggle") {
            throw new Error(`Ação ${action} não suportada pelo dispositivo Kasa.`);
        }

        let desiredState = action === "on" ? 1 : 0;

        if (action === "toggle") {
            const status = await kasaRequest(device.ip, { system: { get_sysinfo: {} } });
            const system = status.system as { get_sysinfo?: { relay_state?: number } } | undefined;
            desiredState = system?.get_sysinfo?.relay_state ? 0 : 1;
        }

        return kasaRequest(device.ip, {
            system: { set_relay_state: { state: desiredState } },
        });
    }

    if (device.protocol === "shelly") {
        const generation = await fetchText(`http://${device.ip}/shelly`, 800);
        const isGen2 = generation ? Number((JSON.parse(generation) as { gen?: number }).gen ?? 1) >= 2 : false;
        const url = isGen2
            ? action === "status"
                ? `http://${device.ip}/rpc/Switch.GetStatus?id=0`
                : `http://${device.ip}/rpc/Switch.Set?id=0&on=${action === "on"}`
            : action === "status"
                ? `http://${device.ip}/relay/0`
                : `http://${device.ip}/relay/0?turn=${action}`;
        const response = await fetchText(url, 1_500);

        if (response === null) {
            throw new Error("O dispositivo Shelly não respondeu.");
        }

        return JSON.parse(response) as unknown;
    }

    if (device.protocol === "wled") {
        if (action === "status") {
            return fetchText(`http://${device.ip}/json/state`, 1_500);
        }

        if (action !== "on" && action !== "off" && action !== "toggle") {
            throw new Error(`Ação ${action} não suportada pelo WLED.`);
        }

        const response = await fetch(`http://${device.ip}/json/state`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(action === "toggle" ? { on: "t" } : { on: action === "on" }),
            signal: AbortSignal.timeout(1_500),
        });

        if (!response.ok) {
            throw new Error(`WLED respondeu ${response.status}.`);
        }

        return response.json() as Promise<unknown>;
    }

    if (device.protocol === "tuya-cloud") {
        if (!device.deviceId) {
            throw new Error("O dispositivo Tuya foi descoberto sem identificador válido.");
        }

        return runTuyaHomeService([
            "control",
            device.deviceId,
            action,
        ]);
    }

    throw new Error(
        `${device.name} foi encontrado automaticamente, mas exige pareamento ou uma integração do fabricante para aceitar esse comando.`,
    );
}
