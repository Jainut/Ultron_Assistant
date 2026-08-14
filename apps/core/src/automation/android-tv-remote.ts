import {
    RemoteKeyCode,
    createAndroidRemote,
    type AndroidRemote,
    type Certificate,
} from "@kud/androidtv-remote";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runtimeConfig } from "../config/runtime.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";
import type { DiscoveredDevice } from "./device-discovery.ts";

export type AndroidTvAction =
    | "on"
    | "off"
    | "toggle"
    | "status"
    | "volume_up"
    | "volume_down"
    | "mute"
    | "unmute"
    | "play"
    | "pause";

interface PairingStore {
    [deviceId: string]: Certificate;
}

interface AndroidTvSession {
    device: DiscoveredDevice;
    remote: AndroidRemote;
    startPromise: Promise<boolean>;
    readyPromise: Promise<void>;
    resolveReady: () => void;
    certificateSavePromise?: Promise<void>;
    ready: boolean;
    pairingRequired: boolean;
    powered?: boolean;
    pendingAction?: AndroidTvAction;
    pairingTimer?: NodeJS.Timeout;
}

export class AndroidTvPairingRequiredError extends Error {
    constructor(public readonly deviceName: string) {
        super(
            `Encontrei ${deviceName}. A TV estÃ¡ exibindo um PIN de pareamento. `
            + "Diga \"cÃ³digo\" seguido dos seis dÃ­gitos para autorizar o Ultron uma Ãºnica vez.",
        );
        this.name = "AndroidTvPairingRequiredError";
    }
}

const pairingPath = path.join(
    runtimeConfig.projectRoot,
    "data",
    "android-tv-pairings.json",
);
const PAIRING_TIMEOUT_MS = 2 * 60_000;
const CONNECTION_TIMEOUT_MS = 8_000;
const REMOTE_READY_TIMEOUT_MS = 5_000;

function abortError(): Error {
    return new DOMException("OperaÃ§Ã£o cancelada.", "AbortError");
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown, value?: T): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
            error === undefined ? resolve(value as T) : reject(error);
        };
        const onAbort = (): void => finish(abortError());
        const timeout = setTimeout(
            () => finish(new Error("A TV demorou demais para responder.")),
            timeoutMs,
        );

        if (signal?.aborted) {
            finish(abortError());
            return;
        }

        signal?.addEventListener("abort", onAbort, { once: true });
        promise.then(value => finish(undefined, value), finish);
    });
}

export async function waitForAndroidTvHandshake(
    startPromise: Promise<boolean>,
    readyPromise: Promise<void>,
    isReady: () => boolean,
    signal?: AbortSignal,
    connectionTimeoutMs = CONNECTION_TIMEOUT_MS,
    readyTimeoutMs = REMOTE_READY_TIMEOUT_MS,
): Promise<boolean> {
    const connected = await waitFor(startPromise, connectionTimeoutMs, signal);

    // start() resolve no secureConnect. O controle sÃ³ estÃ¡ pronto quando a TV
    // envia remoteConfigure e a biblioteca dispara o evento ready.
    if (connected && !isReady()) {
        await waitFor(readyPromise, readyTimeoutMs, signal);
    }

    return connected && isReady();
}

class AndroidTvRemoteService {
    private readonly sessions = new Map<string, AndroidTvSession>();
    private store: PairingStore | null = null;

    hasPendingPairing(): boolean {
        return [...this.sessions.values()].some(session => session.pairingRequired);
    }

    async control(
        device: DiscoveredDevice,
        action: AndroidTvAction,
        signal?: AbortSignal,
    ): Promise<unknown> {
        signal?.throwIfAborted();
        const session = await this.getSession(device);

        if (session.pairingRequired) {
            session.pendingAction = action === "status" ? undefined : action;
            throw new AndroidTvPairingRequiredError(device.name);
        }

        const connected = await waitForAndroidTvHandshake(
            session.startPromise,
            session.readyPromise,
            () => session.ready,
            signal,
        );

        if (!connected) {
            this.disposeSession(device.ip);
            throw new Error(`NÃ£o foi possÃ­vel conectar ao controle remoto de ${device.name}.`);
        }

        return this.execute(session, action);
    }

    async beginPairing(device: DiscoveredDevice, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        const session = await this.getSession(device, true);

        if (session.ready) {
            return { paired: true, message: `${device.name} jÃ¡ estÃ¡ pareada com o Ultron.` };
        }

        if (session.pairingRequired) {
            return {
                paired: false,
                pairingRequired: true,
                message: new AndroidTvPairingRequiredError(device.name).message,
            };
        }

        const connected = await waitForAndroidTvHandshake(
            session.startPromise,
            session.readyPromise,
            () => session.ready,
            signal,
        );

        return {
            paired: connected,
            message: connected
                ? `${device.name} pareada.`
                : "O pareamento nÃ£o foi concluÃ­do pela TV.",
        };
    }

    async submitPairingCode(code: string, signal?: AbortSignal): Promise<{
        device: string;
        paired: boolean;
        executedAction?: AndroidTvAction;
    }> {
        signal?.throwIfAborted();
        const session = [...this.sessions.values()].find(item => item.pairingRequired);

        if (!session) {
            throw new Error("NÃ£o hÃ¡ uma TV aguardando cÃ³digo de pareamento.");
        }

        if (!/^[A-Z0-9]{6}$/i.test(code)) {
            throw new Error("O PIN da TV deve ter seis caracteres.");
        }

        session.pairingRequired = false;
        const accepted = session.remote.sendCode(code.toUpperCase());

        if (!accepted) {
            session.pairingRequired = true;
            throw new Error("A TV nÃ£o aceitou o formato desse PIN.");
        }

        const connected = await waitForAndroidTvHandshake(
            session.startPromise,
            session.readyPromise,
            () => session.ready,
            signal,
            15_000,
        );

        if (!connected) {
            this.disposeSession(session.device.ip);
            throw new Error("A TV nÃ£o concluiu o pareamento. Solicite um novo PIN e tente novamente.");
        }

        await session.certificateSavePromise;

        const pendingAction = session.pendingAction;
        session.pendingAction = undefined;

        if (pendingAction) {
            await this.execute(session, pendingAction);
        }

        return {
            device: session.device.name,
            paired: true,
            executedAction: pendingAction,
        };
    }

    private async getSession(
        device: DiscoveredDevice,
        forcePairing = false,
    ): Promise<AndroidTvSession> {
        const existing = this.sessions.get(device.ip);

        if (existing) return existing;

        const store = await this.loadStore();
        const storedCertificate = forcePairing ? undefined : store[device.id];
        const remote = createAndroidRemote(device.ip, {
            cert: storedCertificate,
            service_name: "Ultron",
            manufacturer: "Ultron",
            model: "Assistente",
            debug: false,
        });
        let resolveReady = (): void => undefined;
        const readyPromise = new Promise<void>(resolve => {
            resolveReady = resolve;
        });
        const session: AndroidTvSession = {
            device,
            remote,
            ready: false,
            pairingRequired: false,
            startPromise: Promise.resolve(false),
            readyPromise,
            resolveReady,
        };

        remote.on("secret", () => {
            session.pairingRequired = true;
            debugLog(`[ANDROID TV] ${device.name} aguardando PIN de pareamento.`);
            session.pairingTimer = setTimeout(() => {
                if (session.pairingRequired) this.disposeSession(device.ip);
            }, PAIRING_TIMEOUT_MS);
            session.pairingTimer.unref();
        });
        remote.on("ready", () => {
            session.ready = true;
            session.pairingRequired = false;
            if (session.pairingTimer) clearTimeout(session.pairingTimer);
            const certificate = remote.getCertificate();
            store[device.id] = certificate;
            session.certificateSavePromise = this.saveStore(store).catch(error => {
                debugLog("[ANDROID TV] Falha ao salvar pareamento:", error);
            });
            session.resolveReady();
            debugLog(`[ANDROID TV] Controle conectado a ${device.name}.`);
        });
        remote.on("powered", powered => {
            session.powered = powered;
        });
        remote.on("unpaired", () => {
            session.ready = false;
            delete store[device.id];
            void this.saveStore(store).catch(error => {
                debugLog("[ANDROID TV] Falha ao remover pareamento invÃ¡lido:", error);
            }).finally(() => {
                this.disposeSession(device.ip);
            });
        });
        remote.on("error", error => {
            debugLog(`[ANDROID TV] ${device.name}:`, error.message);
        });

        this.sessions.set(device.ip, session);
        session.startPromise = perf.measure("Android TV connection", () => remote.start());
        return this.waitUntilPairingState(session);
    }

    private async waitUntilPairingState(session: AndroidTvSession): Promise<AndroidTvSession> {
        if (session.pairingRequired || session.ready) return session;

        await Promise.race([
            session.startPromise.catch(() => false),
            new Promise<void>(resolve => {
                const poll = setInterval(() => {
                    if (session.pairingRequired || session.ready) {
                        clearInterval(poll);
                        resolve();
                    }
                }, 25);
                poll.unref();
                setTimeout(() => {
                    clearInterval(poll);
                    resolve();
                }, CONNECTION_TIMEOUT_MS).unref();
            }),
        ]);
        return session;
    }

    private async execute(session: AndroidTvSession, action: AndroidTvAction): Promise<unknown> {
        if (action === "status") {
            return { online: session.ready, powered: session.powered };
        }

        if (action === "on" || action === "off") {
            const desired = action === "on";

            if (session.powered === desired) {
                return { powered: desired, changed: false };
            }

            session.remote.sendPower();
            session.powered = desired;

            if (!desired) {
                setTimeout(() => this.disposeSession(session.device.ip), 350).unref();
            }

            return { powered: desired, changed: true };
        }

        if (action === "toggle") {
            session.remote.sendPower();
            session.powered = session.powered === undefined ? undefined : !session.powered;
            return { powered: session.powered, changed: true };
        }

        const keys: Partial<Record<AndroidTvAction, number>> = {
            volume_up: RemoteKeyCode.KEYCODE_VOLUME_UP,
            volume_down: RemoteKeyCode.KEYCODE_VOLUME_DOWN,
            mute: RemoteKeyCode.KEYCODE_VOLUME_MUTE,
            unmute: RemoteKeyCode.KEYCODE_VOLUME_MUTE,
            play: RemoteKeyCode.KEYCODE_MEDIA_PLAY,
            pause: RemoteKeyCode.KEYCODE_MEDIA_PAUSE,
        };
        const key = keys[action];

        if (key === undefined) {
            throw new Error(`AÃ§Ã£o ${action} nÃ£o suportada pela Android TV.`);
        }

        session.remote.sendKey(key);
        return { key };
    }

    private async loadStore(): Promise<PairingStore> {
        if (this.store) return this.store;

        try {
            this.store = JSON.parse(await readFile(pairingPath, "utf8")) as PairingStore;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                debugLog("[ANDROID TV] Pareamentos salvos invÃ¡lidos:", error);
            }
            this.store = {};
        }

        return this.store;
    }

    private async saveStore(store: PairingStore): Promise<void> {
        await mkdir(path.dirname(pairingPath), { recursive: true });
        await writeFile(pairingPath, JSON.stringify(store, null, 2), {
            encoding: "utf8",
            mode: 0o600,
        });
    }

    private disposeSession(ip: string): void {
        const session = this.sessions.get(ip);
        if (!session) return;
        if (session.pairingTimer) clearTimeout(session.pairingTimer);
        session.remote.stop();
        this.sessions.delete(ip);
    }
}

export const androidTvRemote = new AndroidTvRemoteService();
