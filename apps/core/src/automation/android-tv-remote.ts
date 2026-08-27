import {
    RemoteKeyCode,
    createAndroidRemote,
    type AndroidRemote,
    type Certificate,
} from "@kud/androidtv-remote";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
    | "previous";

export interface PairingStore {
    [deviceId: string]: Certificate;
}

export interface AndroidTvRemoteServiceOptions {
    remoteFactory?: typeof createAndroidRemote;
    readPairings?: () => Promise<PairingStore>;
    writePairings?: (store: PairingStore) => Promise<void>;
    connectionTimeoutMs?: number;
    readyTimeoutMs?: number;
    powerStateTimeoutMs?: number;
}

export interface AndroidTvCommandResult {
    online?: boolean;
    /** Current device-observed power, omitted while a command is unconfirmed. */
    powered?: boolean;
    observedPowered?: boolean;
    desiredPower?: boolean;
    confirmed: boolean;
    status: "accepted" | "confirmed" | "unknown";
    pending?: boolean;
    changed?: boolean;
    commandSent?: boolean;
    key?: number;
}

export interface AndroidTvPairingResult {
    device: string;
    paired: boolean;
    pairingPersisted?: boolean;
    executedAction?: AndroidTvAction;
    requestedAction?: AndroidTvAction;
    actionResult?: AndroidTvCommandResult;
    actionError?: string;
}

interface AndroidTvSession {
    device: DiscoveredDevice;
    remote: AndroidRemote;
    startPromise: Promise<boolean>;
    readyPromise: Promise<void>;
    resolveReady: () => void;
    poweredPromise: Promise<void>;
    resolvePowered: () => void;
    statePromise: Promise<void>;
    resolveState: () => void;
    lifecycle: AbortController;
    certificateSavePromise?: Promise<void>;
    pairingPersisted?: boolean;
    ready: boolean;
    pairingRequired: boolean;
    observedPowered?: boolean;
    pendingPower?: { desired?: boolean };
    pendingAction?: AndroidTvAction;
    pairingTimer?: NodeJS.Timeout;
    powerOffTimer?: NodeJS.Timeout;
}

export class AndroidTvPairingRequiredError extends Error {
    constructor(public readonly deviceName: string) {
        super(
            `Encontrei ${deviceName}. A TV está exibindo um PIN de pareamento. `
            + "Diga \"código\" seguido dos seis caracteres para autorizar o Ultron.",
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
    return new DOMException("Operação cancelada.", "AbortError");
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
        const onAbort = (): void => finish(
            signal?.reason instanceof Error ? signal.reason : abortError(),
        );
        const timeout = setTimeout(
            () => finish(new Error("A TV demorou demais para responder.")),
            timeoutMs,
        );
        // Always consume a late rejection, including when cancellation wins.
        promise.then(value => finish(undefined, value), finish);

        if (signal?.aborted) {
            onAbort();
            return;
        }

        signal?.addEventListener("abort", onAbort, { once: true });
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

    // start() resolve no secureConnect. O controle só está pronto quando a TV
    // envia remoteConfigure e a biblioteca dispara o evento ready.
    if (connected && !isReady()) {
        await waitFor(readyPromise, readyTimeoutMs, signal);
    }

    return connected && isReady();
}

export class AndroidTvRemoteService {
    private readonly sessions = new Map<string, AndroidTvSession>();
    private store: PairingStore | null = null;
    private storePromise: Promise<PairingStore> | null = null;
    private storeWrite: Promise<void> = Promise.resolve();
    private generation = 0;

    constructor(private readonly options: AndroidTvRemoteServiceOptions = {}) {}

    stop(): void {
        this.generation += 1;
        for (const [ip, session] of this.sessions) {
            this.disposeSession(ip, session, new Error("Controle da Android TV encerrado."));
        }
    }

    hasPendingPairing(): boolean {
        return [...this.sessions.values()].some(session => session.pairingRequired);
    }

    async control(
        device: DiscoveredDevice,
        action: AndroidTvAction,
        signal?: AbortSignal,
    ): Promise<AndroidTvCommandResult> {
        signal?.throwIfAborted();
        const session = await this.getSession(device, signal);
        this.sessionSignal(session, signal).throwIfAborted();

        if (session.pairingRequired) {
            session.pendingAction = action === "status" ? undefined : action;
            throw new AndroidTvPairingRequiredError(device.name);
        }

        await this.connectSession(session, signal);
        return this.execute(session, action, signal);
    }

    async beginPairing(device: DiscoveredDevice, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        const generation = this.generation;
        try {
            return await this.pairingState(await this.getSession(device, signal), signal);
        } catch (error) {
            if (signal?.aborted || generation !== this.generation) throw error;
            const store = await this.loadStore();
            if (generation !== this.generation) throw error;
            if (!store[this.storeKey(device)] && !store[device.id]) throw error;

            // Only an explicit pairing request may replace a saved certificate.
            // A transport reset alone must not erase a still-valid pairing.
            return this.pairingState(await this.getSession(device, signal, true), signal);
        }
    }

    private async pairingState(session: AndroidTvSession, signal?: AbortSignal): Promise<unknown> {
        const device = session.device;

        if (session.ready) {
            return {
                paired: true,
                confirmed: true,
                status: "confirmed",
                message: `${device.name} já está pareada com o Ultron.`,
            };
        }

        if (session.pairingRequired) {
            return {
                paired: false,
                pairingRequired: true,
                confirmed: false,
                status: "accepted",
                message: new AndroidTvPairingRequiredError(device.name).message,
            };
        }

        await this.connectSession(session, signal);

        return {
            paired: true,
            confirmed: true,
            status: "confirmed",
            message: `${device.name} pareada.`,
        };
    }

    async submitPairingCode(code: string, signal?: AbortSignal): Promise<AndroidTvPairingResult> {
        signal?.throwIfAborted();
        const session = [...this.sessions.values()].find(item => item.pairingRequired);

        if (!session) {
            throw new Error("Não há uma TV aguardando código de pareamento.");
        }

        if (!/^[A-Z0-9]{6}$/i.test(code)) {
            throw new Error("O PIN da TV deve ter seis caracteres.");
        }

        session.pairingRequired = false;
        const accepted = session.remote.sendCode(code.toUpperCase());

        if (!accepted) {
            session.pairingRequired = true;
            throw new Error("A TV não aceitou o formato desse PIN.");
        }

        await this.connectSession(session, signal, 15_000);

        await session.certificateSavePromise;
        signal?.throwIfAborted();

        const pendingAction = session.pendingAction;
        session.pendingAction = undefined;

        let actionResult: AndroidTvCommandResult | undefined;
        let actionError: string | undefined;
        if (pendingAction) {
            try {
                actionResult = await this.execute(session, pendingAction, signal);
            } catch (error) {
                if (signal?.aborted) throw error;
                actionError = error instanceof Error ? error.message : String(error);
            }
        }

        return {
            device: session.device.name,
            paired: true,
            pairingPersisted: session.pairingPersisted,
            requestedAction: pendingAction,
            executedAction: actionResult ? pendingAction : undefined,
            actionResult,
            actionError,
        };
    }

    private sessionSignal(session: AndroidTvSession, signal?: AbortSignal): AbortSignal {
        return signal
            ? AbortSignal.any([signal, session.lifecycle.signal])
            : session.lifecycle.signal;
    }

    private async connectSession(
        session: AndroidTvSession,
        signal?: AbortSignal,
        timeoutMs = this.options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
    ): Promise<void> {
        try {
            const connected = await waitForAndroidTvHandshake(
                session.startPromise,
                session.readyPromise,
                () => session.ready,
                this.sessionSignal(session, signal),
                timeoutMs,
                this.options.readyTimeoutMs ?? REMOTE_READY_TIMEOUT_MS,
            );
            if (!connected) {
                throw new Error(`Não foi possível conectar ao controle remoto de ${session.device.name}.`);
            }
        } catch (error) {
            this.disposeSession(session.device.ip, session);
            throw error;
        }
    }

    private storeKey(device: DiscoveredDevice): string {
        return device.mac
            ? `mac:${device.mac.replace(/[^0-9a-f]/gi, "").toUpperCase()}`
            : device.id;
    }

    private async getSession(
        device: DiscoveredDevice,
        signal?: AbortSignal,
        freshPairing = false,
    ): Promise<AndroidTvSession> {
        signal?.throwIfAborted();
        if (freshPairing) this.disposeSession(device.ip);
        const existing = this.sessions.get(device.ip);

        if (existing) return this.waitUntilPairingState(existing, signal);

        const generation = this.generation;
        const store = await this.loadStore();
        signal?.throwIfAborted();
        if (generation !== this.generation) throw new Error("Controle da Android TV encerrado.");
        // Concurrent callers may have created the session while the store loaded.
        const loadedSession = this.sessions.get(device.ip);
        if (loadedSession) return this.waitUntilPairingState(loadedSession, signal);
        const storeKey = this.storeKey(device);
        const storedCertificate = freshPairing ? undefined : store[storeKey] ?? store[device.id];
        const remote = (this.options.remoteFactory ?? createAndroidRemote)(device.ip, {
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
        let resolvePowered = (): void => undefined;
        const poweredPromise = new Promise<void>(resolve => {
            resolvePowered = resolve;
        });
        let resolveState = (): void => undefined;
        const statePromise = new Promise<void>(resolve => {
            resolveState = resolve;
        });
        const session: AndroidTvSession = {
            device,
            remote,
            ready: false,
            pairingRequired: false,
            startPromise: Promise.resolve(false),
            readyPromise,
            resolveReady,
            poweredPromise,
            resolvePowered,
            statePromise,
            resolveState,
            lifecycle: new AbortController(),
        };

        remote.on("secret", () => {
            if (!this.isCurrent(session)) return;
            session.pairingRequired = true;
            session.resolveState();
            debugLog(`[ANDROID TV] ${device.name} aguardando PIN de pareamento.`);
            if (session.pairingTimer) clearTimeout(session.pairingTimer);
            session.pairingTimer = setTimeout(() => {
                if (session.pairingRequired) this.disposeSession(device.ip, session);
            }, PAIRING_TIMEOUT_MS);
            session.pairingTimer.unref();
        });
        remote.on("ready", () => {
            if (!this.isCurrent(session)) return;
            session.ready = true;
            session.pairingRequired = false;
            // The remote can reconnect internally. Old observations must not
            // be used as current state before the new powered event arrives.
            session.observedPowered = undefined;
            session.poweredPromise = new Promise<void>(resolve => {
                session.resolvePowered = resolve;
            });
            if (session.pairingTimer) clearTimeout(session.pairingTimer);
            const certificate = remote.getCertificate();
            store[storeKey] = certificate;
            if (storeKey !== device.id) delete store[device.id];
            session.certificateSavePromise = this.saveStore(store)
                .then(() => { session.pairingPersisted = true; })
                .catch(error => {
                    session.pairingPersisted = false;
                    debugLog("[ANDROID TV] Falha ao salvar pareamento:", error);
                });
            session.resolveReady();
            session.resolveState();
            debugLog(`[ANDROID TV] Controle conectado a ${device.name}.`);
        });
        remote.on("powered", powered => {
            if (!this.isCurrent(session) || typeof powered !== "boolean") return;
            session.observedPowered = powered;
            if (session.pendingPower && (
                session.pendingPower.desired === undefined
                || session.pendingPower.desired === powered
            )) {
                session.pendingPower = undefined;
            }
            session.resolvePowered();
        });
        remote.on("unpaired", () => {
            if (!this.isCurrent(session)) return;
            // This library also emits `unpaired` for ECONNRESET. That is not
            // evidence that the TV revoked the certificate. Reuse it next time.
            this.disposeSession(device.ip, session, new Error(
                "A conexão com a TV foi interrompida. O pareamento salvo foi preservado; tente novamente.",
            ));
        });
        remote.on("error", error => {
            if (!this.isCurrent(session)) return;
            debugLog(`[ANDROID TV] ${device.name}:`, error.message);
            this.disposeSession(device.ip, session, error);
        });

        this.sessions.set(device.ip, session);
        session.startPromise = perf.measure("Android TV connection", () => remote.start());
        return this.waitUntilPairingState(session, signal);
    }

    private async waitUntilPairingState(
        session: AndroidTvSession,
        signal?: AbortSignal,
    ): Promise<AndroidTvSession> {
        if (session.pairingRequired || session.ready) return session;

        try {
            await waitFor(Promise.race([
                session.startPromise,
                session.statePromise,
            ]), this.options.connectionTimeoutMs ?? CONNECTION_TIMEOUT_MS,
            this.sessionSignal(session, signal));
        } catch (error) {
            this.disposeSession(session.device.ip, session);
            throw error;
        }
        return session;
    }

    private powerResult(session: AndroidTvSession): AndroidTvCommandResult {
        const confirmed = session.ready
            && session.observedPowered !== undefined
            && session.pendingPower === undefined;
        return {
            online: session.ready,
            powered: confirmed ? session.observedPowered : undefined,
            observedPowered: session.observedPowered,
            desiredPower: session.pendingPower?.desired,
            pending: session.pendingPower !== undefined,
            confirmed,
            status: confirmed ? "confirmed" : "unknown",
        };
    }

    private async waitForPower(session: AndroidTvSession, signal?: AbortSignal): Promise<void> {
        const operationSignal = this.sessionSignal(session, signal);
        operationSignal.throwIfAborted();
        if (session.observedPowered !== undefined || session.pendingPower) return;
        try {
            await waitFor(session.poweredPromise, this.options.powerStateTimeoutMs ?? 600, operationSignal);
        } catch (error) {
            if (operationSignal.aborted) throw error;
            // A timeout is an unknown state, never evidence that the TV is off.
        }
    }

    private async execute(
        session: AndroidTvSession,
        action: AndroidTvAction,
        signal?: AbortSignal,
    ): Promise<AndroidTvCommandResult> {
        this.sessionSignal(session, signal).throwIfAborted();
        if (action === "status") {
            await this.waitForPower(session, signal);
            this.sessionSignal(session, signal).throwIfAborted();
            return this.powerResult(session);
        }

        if (action === "on" || action === "off") {
            const desired = action === "on";
            await this.waitForPower(session, signal);
            this.sessionSignal(session, signal).throwIfAborted();

            if (session.pendingPower) {
                if (session.pendingPower.desired === desired) {
                    return {
                        ...this.powerResult(session),
                        status: "accepted",
                        changed: false,
                        commandSent: false,
                    };
                }
                throw new Error("A TV ainda não confirmou o comando anterior. Não enviei outro Power para evitar inverter a energia.");
            }

            if (session.observedPowered === undefined) {
                throw new Error("A TV não informou se está ligada ou desligada. Não enviei Power para evitar inverter a energia por engano.");
            }

            if (session.observedPowered === desired) {
                return { ...this.powerResult(session), changed: false, commandSent: false };
            }

            if (session.powerOffTimer) clearTimeout(session.powerOffTimer);
            session.pendingPower = { desired };
            session.remote.sendPower();

            if (!desired) {
                session.powerOffTimer = setTimeout(
                    () => this.disposeSession(session.device.ip, session),
                    350,
                );
                session.powerOffTimer.unref();
            }

            const result = this.powerResult(session);
            return { ...result, status: result.confirmed ? "confirmed" : "accepted", changed: true, commandSent: true };
        }

        if (action === "toggle") {
            if (session.powerOffTimer) clearTimeout(session.powerOffTimer);
            const observed = this.powerResult(session);
            session.pendingPower = { desired: observed.confirmed ? !observed.powered : undefined };
            session.remote.sendPower();
            const result = this.powerResult(session);
            return { ...result, status: result.confirmed ? "confirmed" : "accepted", changed: true, commandSent: true };
        }

        const keys: Partial<Record<AndroidTvAction, number>> = {
            volume_up: RemoteKeyCode.KEYCODE_VOLUME_UP,
            volume_down: RemoteKeyCode.KEYCODE_VOLUME_DOWN,
            mute: RemoteKeyCode.KEYCODE_VOLUME_MUTE,
            unmute: RemoteKeyCode.KEYCODE_VOLUME_MUTE,
            play: RemoteKeyCode.KEYCODE_MEDIA_PLAY,
            pause: RemoteKeyCode.KEYCODE_MEDIA_PAUSE,
            stop: RemoteKeyCode.KEYCODE_MEDIA_STOP,
            home: RemoteKeyCode.KEYCODE_HOME,
            back: RemoteKeyCode.KEYCODE_BACK,
            up: RemoteKeyCode.KEYCODE_DPAD_UP,
            down: RemoteKeyCode.KEYCODE_DPAD_DOWN,
            left: RemoteKeyCode.KEYCODE_DPAD_LEFT,
            right: RemoteKeyCode.KEYCODE_DPAD_RIGHT,
            select: RemoteKeyCode.KEYCODE_DPAD_CENTER,
            menu: RemoteKeyCode.KEYCODE_MENU,
            input: RemoteKeyCode.KEYCODE_TV_INPUT,
            channel_up: RemoteKeyCode.KEYCODE_CHANNEL_UP,
            channel_down: RemoteKeyCode.KEYCODE_CHANNEL_DOWN,
            next: RemoteKeyCode.KEYCODE_MEDIA_NEXT,
            previous: RemoteKeyCode.KEYCODE_MEDIA_PREVIOUS,
        };
        const key = keys[action];

        if (key === undefined) {
            throw new Error(`Ação ${action} não suportada pela Android TV.`);
        }

        session.remote.sendKey(key);
        return { key, commandSent: true, confirmed: false, status: "accepted" };
    }

    private async loadStore(): Promise<PairingStore> {
        if (this.store) return this.store;
        if (this.storePromise) return this.storePromise;

        this.storePromise = (async () => {
            try {
                this.store = this.options.readPairings
                    ? await this.options.readPairings()
                    : JSON.parse(await readFile(pairingPath, "utf8")) as PairingStore;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    debugLog("[ANDROID TV] Pareamentos salvos inválidos:", error);
                }
                this.store = {};
            }

            return this.store;
        })();
        return this.storePromise;
    }

    private async saveStore(store: PairingStore): Promise<void> {
        const snapshot = structuredClone(store);
        const write = async (): Promise<void> => {
            if (this.options.writePairings) {
                await this.options.writePairings(snapshot);
                return;
            }
            await mkdir(path.dirname(pairingPath), { recursive: true });
            const temporary = `${pairingPath}.${randomUUID()}.tmp`;
            try {
                await writeFile(temporary, JSON.stringify(snapshot, null, 2), {
                    encoding: "utf8", mode: 0o600, flag: "wx",
                });
                await rename(temporary, pairingPath);
            } finally {
                await rm(temporary, { force: true }).catch(() => undefined);
            }
        };
        const operation = this.storeWrite.then(write, write);
        this.storeWrite = operation.catch(() => undefined);
        await operation;
    }

    private isCurrent(session: AndroidTvSession): boolean {
        return this.sessions.get(session.device.ip) === session && !session.lifecycle.signal.aborted;
    }

    private disposeSession(
        ip: string,
        expectedSession?: AndroidTvSession,
        reason = new Error("A sessão da TV foi encerrada; tente novamente."),
    ): void {
        const session = this.sessions.get(ip);
        if (!session || (expectedSession && expectedSession !== session)) return;
        this.sessions.delete(ip);
        session.ready = false;
        session.pairingRequired = false;
        session.observedPowered = undefined;
        session.pendingPower = undefined;
        session.pendingAction = undefined;
        if (session.pairingTimer) clearTimeout(session.pairingTimer);
        if (session.powerOffTimer) clearTimeout(session.powerOffTimer);
        session.lifecycle.abort(reason);
        try {
            session.remote.stop();
        } catch (error) {
            debugLog("[ANDROID TV] Falha ao encerrar conexão:", error);
        }
    }
}

export const androidTvRemote = new AndroidTvRemoteService();
