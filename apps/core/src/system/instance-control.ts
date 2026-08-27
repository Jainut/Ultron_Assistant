import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { RemoteCommandInbox, type RemoteCommand, type StagedRemoteCommand } from "./remote-command-inbox.ts";

export const INSTANCE_PROTOCOL = "ultron-instance";
export const INSTANCE_PROTOCOL_VERSION = 1;
export const MAX_INSTANCE_FRAME_BYTES = 16_384;
export const MAX_REMOTE_COMMAND_BYTES = 8_192;
const MAX_CLIENTS = 16;
const MAX_REMEMBERED_REQUESTS = 256;
const REQUEST_MEMORY_MS = 5 * 60_000;

export type InstancePhase = "starting" | "ready" | "degraded" | "stopping";
export type InstanceOperation = "status" | "hud" | "command" | "stop";

export interface InstanceStatus {
    readonly instanceId: string;
    readonly pid: number;
    readonly phase: InstancePhase;
    readonly startedAt: string;
    readonly hudUrl?: string;
    readonly queuedCommands: number;
    readonly detail?: string;
}

export interface InstanceRequest {
    readonly protocol: typeof INSTANCE_PROTOCOL;
    readonly version: typeof INSTANCE_PROTOCOL_VERSION;
    readonly id: string;
    readonly operation: InstanceOperation;
    readonly text?: string;
}

export interface InstanceReply {
    readonly protocol: typeof INSTANCE_PROTOCOL;
    readonly version: typeof INSTANCE_PROTOCOL_VERSION;
    readonly id: string;
    readonly ok: boolean;
    readonly status?: InstanceStatus;
    readonly disposition?: "accepted";
    readonly message?: string;
    readonly code?: string;
}

export interface InstanceAddress {
    readonly pipePath: string;
    /** Private directory is needed only for Unix socket permissions. */
    readonly privateDirectory?: string;
}

export class InstanceControlError extends Error {
    constructor(message: string, readonly code: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "InstanceControlError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function instanceAddress(projectRoot: string): InstanceAddress {
    let root = realpathSync(projectRoot);
    let userDirectory = homedir();
    if (process.platform === "win32") {
        root = root.toLowerCase();
        userDirectory = userDirectory.toLowerCase();
    }
    const user = userInfo();
    // Namespace only, NOT a secret. Authorization is enforced by OS pipe ACLs.
    const identity = `${user.uid}:${user.username}:${userDirectory}`;
    const digest = createHash("sha256").update(`${identity}\0${root}`).digest("hex").slice(0, 32);
    if (process.platform === "win32") {
        return { pipePath: `\\\\.\\pipe\\ultron-${digest}` };
    }
    const privateDirectory = path.join(tmpdir(), `ultron-${createHash("sha256").update(identity).digest("hex").slice(0, 12)}`);
    return { privateDirectory, pipePath: path.join(privateDirectory, `${digest}.sock`) };
}

async function ensurePrivateDirectory(address: InstanceAddress): Promise<void> {
    if (!address.privateDirectory) return;
    await mkdir(address.privateDirectory, { recursive: true, mode: 0o700 });
    const entry = await lstat(address.privateDirectory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()) {
        throw new InstanceControlError("O diretório IPC não pertence ao usuário atual.", "UNSAFE_IPC_DIRECTORY");
    }
    await chmod(address.privateDirectory, 0o700);
}

function validRequestId(value: unknown): value is string {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
}

export function validateRemoteText(value: unknown): value is string {
    return typeof value === "string"
        && value.trim().length > 0
        && Buffer.byteLength(value, "utf8") <= MAX_REMOTE_COMMAND_BYTES
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export function parseInstanceRequest(value: unknown): InstanceRequest | null {
    if (!isRecord(value)
        || value.protocol !== INSTANCE_PROTOCOL
        || value.version !== INSTANCE_PROTOCOL_VERSION
        || !validRequestId(value.id)
        || !["status", "hud", "command", "stop"].includes(String(value.operation))
        || Object.keys(value).some(key => !["protocol", "version", "id", "operation", "text"].includes(key))) return null;
    if (value.operation === "command" ? !validateRemoteText(value.text) : value.text !== undefined) return null;
    return value as unknown as InstanceRequest;
}

function isStatus(value: unknown): value is InstanceStatus {
    if (!isRecord(value) || !validRequestId(value.instanceId)
        || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
        || !["starting", "ready", "degraded", "stopping"].includes(String(value.phase))
        || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
        || !Number.isSafeInteger(value.queuedCommands) || Number(value.queuedCommands) < 0
        || (value.hudUrl !== undefined && !isLocalHudUrl(value.hudUrl))
        || (value.detail !== undefined && typeof value.detail !== "string")) return false;
    return true;
}

export function isLocalHudUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const explicitPort = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(value)?.[1];
    if (!explicitPort || Number(explicitPort) < 1 || Number(explicitPort) > 65_535) return false;
    try {
        const url = new URL(value);
        return url.protocol === "http:" && url.hostname === "127.0.0.1"
            && url.username === "" && url.password === "" && url.pathname === "/"
            && url.search === "" && url.hash === "";
    } catch { return false; }
}

function parseReply(value: unknown, id: string): InstanceReply {
    if (!isRecord(value) || value.protocol !== INSTANCE_PROTOCOL || value.version !== INSTANCE_PROTOCOL_VERSION
        || value.id !== id || typeof value.ok !== "boolean"
        || (value.status !== undefined && !isStatus(value.status))
        || (value.disposition !== undefined && value.disposition !== "accepted")
        || (value.message !== undefined && typeof value.message !== "string")
        || (value.code !== undefined && typeof value.code !== "string")) {
        throw new InstanceControlError("O canal ocupado não respondeu com o protocolo esperado. Nenhuma segunda instância será iniciada.", "INVALID_INSTANCE_REPLY");
    }
    return value as unknown as InstanceReply;
}

export function isInstanceAbsent(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ENOENT" || code === "ECONNREFUSED";
}

export interface InstanceClientOptions {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly requestId?: string;
}

/** One bounded request per connection. No automatic retries after an uncertain write. */
export function requestInstance(
    address: InstanceAddress,
    operation: InstanceOperation,
    text?: string,
    options: InstanceClientOptions = {},
): Promise<InstanceReply> {
    const request: InstanceRequest = {
        protocol: INSTANCE_PROTOCOL,
        version: INSTANCE_PROTOCOL_VERSION,
        id: options.requestId ?? randomUUID(),
        operation,
        ...(text === undefined ? {} : { text }),
    };
    if (!parseInstanceRequest(request)) return Promise.reject(new InstanceControlError("Comando IPC inválido.", "INVALID_REQUEST"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const frame = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    if (frame.length > MAX_INSTANCE_FRAME_BYTES) return Promise.reject(new InstanceControlError("Comando excedeu o limite IPC.", "FRAME_TOO_LARGE"));
    return new Promise<InstanceReply>((resolve, reject) => {
        let settled = false;
        let buffer = Buffer.alloc(0);
        const socket = createConnection(address.pipePath);
        const finish = (error?: unknown, reply?: InstanceReply): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            socket.destroy();
            error === undefined ? resolve(reply!) : reject(error);
        };
        const abort = (): void => finish(options.signal?.reason ?? new DOMException("Comando cancelado", "AbortError"));
        const timer = setTimeout(() => finish(new InstanceControlError(
            "A instância não respondeu a tempo. O comando não será reenviado automaticamente.", "INSTANCE_TIMEOUT",
        )), options.timeoutMs ?? 2_000);
        options.signal?.addEventListener("abort", abort, { once: true });
        socket.once("connect", () => socket.write(frame));
        socket.on("error", finish);
        socket.on("data", (chunk: Buffer) => {
            if (settled) return;
            if (buffer.length + chunk.length > MAX_INSTANCE_FRAME_BYTES) {
                finish(new InstanceControlError("Resposta IPC excedeu o limite.", "FRAME_TOO_LARGE"));
                return;
            }
            buffer = Buffer.concat([buffer, chunk]);
            const newline = buffer.indexOf(10);
            if (newline < 0) return;
            if (newline !== buffer.length - 1) {
                finish(new InstanceControlError("O canal enviou mais de uma resposta.", "INVALID_INSTANCE_REPLY"));
                return;
            }
            try { finish(undefined, parseReply(JSON.parse(buffer.subarray(0, newline).toString("utf8")), request.id)); }
            catch (error) { finish(error instanceof InstanceControlError ? error : new InstanceControlError("Resposta IPC inválida.", "INVALID_INSTANCE_REPLY")); }
        });
        socket.once("close", () => finish(new InstanceControlError("A instância fechou o canal sem confirmar o comando. Não houve reenvio.", "INSTANCE_DISCONNECTED")));
    });
}

interface RememberedRequest {
    readonly fingerprint: string;
    readonly response: InstanceReply;
    readonly expiresAt: number;
    committed: boolean;
}

export interface InstanceControlOptions {
    readonly address: InstanceAddress;
    readonly requestTimeoutMs?: number;
}

export class InstanceControl {
    private server: Server | null = null;
    private readonly sockets = new Set<Socket>();
    private readonly commands = new RemoteCommandInbox();
    private readonly remembered = new Map<string, RememberedRequest>();
    private readonly instanceId = randomUUID();
    private readonly startedAt = new Date().toISOString();
    private phase: InstancePhase = "starting";
    private hudUrl: string | undefined;
    private detail: string | undefined;
    private shutdownHandler: (() => void) | null = null;
    private shutdownRequested = false;
    private closePromise: Promise<void> | null = null;

    private constructor(private readonly options: InstanceControlOptions) {}

    static async acquire(options: InstanceControlOptions): Promise<InstanceControl | null> {
        await ensurePrivateDirectory(options.address);
        const instance = new InstanceControl(options);
        try {
            await instance.listen();
            return instance;
        } catch (error) {
            await instance.close();
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EADDRINUSE") return null;
            // Permission errors, stale sockets and unknown occupancy are NOT permission to start twice.
            throw error;
        }
    }

    status(): InstanceStatus {
        return {
            instanceId: this.instanceId,
            pid: process.pid,
            phase: this.phase,
            startedAt: this.startedAt,
            queuedCommands: this.commands.size,
            ...(this.hudUrl ? { hudUrl: this.hudUrl } : {}),
            ...(this.detail ? { detail: this.detail } : {}),
        };
    }

    update(update: { phase?: InstancePhase; hudUrl?: string; detail?: string }): void {
        if (this.phase === "stopping" && update.phase !== "stopping") return;
        if (update.phase) this.phase = update.phase;
        if (update.hudUrl && isLocalHudUrl(update.hudUrl)) this.hudUrl = update.hudUrl;
        if (update.detail !== undefined) this.detail = update.detail;
    }

    onShutdown(handler: () => void): void {
        this.shutdownHandler = handler;
        if (this.shutdownRequested) handler();
    }

    onCommandAccepted(handler: () => void): void { this.commands.onAccepted(handler); }
    nextCommand(): Promise<RemoteCommand> { return this.commands.next(); }

    acceptInitialCommand(text: string): void {
        if (!validateRemoteText(text)) throw new InstanceControlError("Comando inicial inválido.", "INVALID_REQUEST");
        this.commands.stage({ requestId: randomUUID(), text: text.trim() }).commit();
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.phase = "stopping";
        this.commands.stop();
        this.closePromise = new Promise<void>((resolve) => {
            for (const socket of this.sockets) socket.destroy();
            this.sockets.clear();
            this.remembered.clear();
            const server = this.server;
            this.server = null;
            if (!server?.listening) { resolve(); return; }
            server.close(() => resolve());
        });
        return this.closePromise;
    }

    private async listen(): Promise<void> {
        const server = createServer(socket => this.handleConnection(socket));
        server.maxConnections = MAX_CLIENTS;
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
            const onListening = (): void => { server.off("error", onError); resolve(); };
            server.once("error", onError);
            server.once("listening", onListening);
            // libuv uses FILE_FLAG_FIRST_PIPE_INSTANCE at bind on Windows.
            // Do not set readableAll/writableAll: the default Windows ACL remains in force.
            server.listen({ path: this.options.address.pipePath, exclusive: true, readableAll: false, writableAll: false });
        });
        if (process.platform !== "win32") await chmod(this.options.address.pipePath, 0o600);
        server.on("error", () => {
            this.phase = "stopping";
            this.shutdownRequested = true;
            this.shutdownHandler?.();
        });
    }

    private handleConnection(socket: Socket): void {
        if (this.sockets.size >= MAX_CLIENTS) { socket.destroy(); return; }
        this.sockets.add(socket);
        let buffer = Buffer.alloc(0);
        let handled = false;
        let connectionClosed = false;
        let staged: StagedRemoteCommand | null = null;
        let rememberedId: string | null = null;
        const timer = setTimeout(() => socket.destroy(), this.options.requestTimeoutMs ?? 3_000);
        const cleanup = (): void => {
            connectionClosed = true;
            clearTimeout(timer);
            staged?.cancel();
            if (rememberedId && !this.remembered.get(rememberedId)?.committed) this.remembered.delete(rememberedId);
            this.sockets.delete(socket);
        };
        socket.once("close", cleanup);
        socket.on("error", () => socket.destroy());
        const send = (response: InstanceReply, afterWritten?: () => void): void => {
            handled = true;
            const payload = `${JSON.stringify(response)}\n`;
            if (Buffer.byteLength(payload) > MAX_INSTANCE_FRAME_BYTES) { socket.destroy(); return; }
            socket.end(payload, () => {
                if (connectionClosed) return;
                if (rememberedId) {
                    const entry = this.remembered.get(rememberedId);
                    if (entry) entry.committed = true;
                }
                afterWritten?.();
            });
        };
        socket.on("data", (chunk: Buffer) => {
            if (handled) { socket.destroy(); return; }
            if (buffer.length + chunk.length > MAX_INSTANCE_FRAME_BYTES) { socket.destroy(); return; }
            buffer = Buffer.concat([buffer, chunk]);
            const newline = buffer.indexOf(10);
            if (newline < 0) return;
            if (newline !== buffer.length - 1) { socket.destroy(); return; }
            let request: InstanceRequest | null = null;
            try { request = parseInstanceRequest(JSON.parse(buffer.subarray(0, newline).toString("utf8"))); }
            catch { /* Invalid input cannot dispatch a tool. */ }
            if (!request) { socket.destroy(); return; }
            const base = { protocol: INSTANCE_PROTOCOL, version: INSTANCE_PROTOCOL_VERSION, id: request.id } as const;
            const fingerprint = `${request.operation}\0${request.text ?? ""}`;
            const previous = this.remembered.get(request.id);
            if (previous && previous.expiresAt > Date.now()) {
                if (previous.fingerprint !== fingerprint) {
                    send({ ...base, ok: false, code: "REQUEST_ID_REUSED", message: "Identificador já usado por outro comando." });
                } else if (!previous.committed) {
                    send({ ...base, ok: false, code: "REQUEST_PENDING", message: "Este comando ainda está sendo recebido; não foi executado novamente." });
                } else send(previous.response);
                return;
            }
            if (request.operation === "status" || request.operation === "hud") {
                send({ ...base, ok: true, status: this.status() });
                return;
            }
            if (this.phase === "stopping") {
                send({ ...base, ok: false, code: "INSTANCE_STOPPING", message: "O Ultron está encerrando; nenhum comando foi enfileirado." });
                return;
            }
            if (request.operation === "command") {
                try { staged = this.commands.stage({ requestId: request.id, text: request.text!.trim() }); }
                catch (error) { send({ ...base, ok: false, code: "COMMAND_QUEUE_FULL", message: (error as Error).message }); return; }
            }
            const response: InstanceReply = {
                ...base, ok: true, disposition: "accepted", status: this.status(),
                message: request.operation === "stop"
                    ? "Encerramento solicitado."
                    : "Comando recebido pela instância principal; execução ainda não confirmada.",
            };
            this.remember(request.id, { fingerprint, response, committed: false, expiresAt: Date.now() + REQUEST_MEMORY_MS });
            rememberedId = request.id;
            const operation = request.operation;
            send(response, () => {
                if (operation === "command") staged?.commit();
                else {
                    this.phase = "stopping";
                    this.shutdownRequested = true;
                    this.shutdownHandler?.();
                }
            });
        });
    }

    private remember(id: string, value: RememberedRequest): void {
        const now = Date.now();
        for (const [key, entry] of this.remembered) if (entry.expiresAt <= now) this.remembered.delete(key);
        while (this.remembered.size >= MAX_REMEMBERED_REQUESTS) this.remembered.delete(this.remembered.keys().next().value!);
        this.remembered.set(id, value);
    }
}
