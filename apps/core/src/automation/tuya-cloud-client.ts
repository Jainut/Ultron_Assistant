import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";

import { servicePath } from "../config/runtime.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";
import { awaitServiceOperation, timedServiceOperation } from "../system/service-lifecycle.ts";

type PendingRequest = {
    id: string;
    argumentsList: string[];
    queuedAt: number;
    startedAt?: number;
    resolve: (result: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    removeAbortListener?: () => void;
};

export interface TuyaClientOptions {
    mode?: "light" | "home";
    timeoutMs?: number;
    /** Process seam for lifecycle tests; production always uses the existing venv. */
    spawnProcess?: (mode: "light" | "home") => ChildProcessWithoutNullStreams;
}

type ServiceResult = {
    id?: string;
    type?: string;
    success?: boolean;
    error?: string;
    [key: string]: unknown;
};

export class TuyaCloudClient {
    private child: ChildProcessWithoutNullStreams | null = null;
    private readonly pending = new Map<string, PendingRequest>();
    private activeId: string | null = null;
    private ready = false;
    private readiness: { promise: Promise<void>; resolve(): void; reject(error: Error): void } | null = null;
    private readonly failureListeners = new Set<(error: Error) => void>();

    constructor(private readonly options: TuyaClientOptions = {}) {}

    start(): void {
        if (this.child) return;
        this.ready = false;
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        const promise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        void promise.catch(() => undefined);
        this.readiness = { promise, resolve: resolveReady, reject: rejectReady };
        let child: ChildProcessWithoutNullStreams;
        try {
            child = this.options.spawnProcess?.(this.options.mode ?? "light") ?? this.spawnService();
        } catch {
            const error = new Error("Não foi possível iniciar o serviço Tuya.");
            this.readiness.reject(error);
            this.readiness = null;
            throw error;
        }
        this.child = child;
        const lines = createInterface({ input: child.stdout });
        lines.on("line", line => {
            if (this.child === child) this.handleLine(line);
        });
        // TinyTuya debug/tracebacks may include signed URLs or credentials.
        child.stderr.on("data", () => debugLog("[TUYA] Diagnóstico recebido do serviço."));
        const failed = (error: Error): void => {
            if (this.child !== child) return;
            this.retire(child);
            this.failAll(error);
            for (const listener of this.failureListeners) {
                try { listener(error); } catch { /* Observer isolation. */ }
            }
        };
        child.stdin.on("error", () => failed(new Error("Canal do serviço Tuya indisponível.")));
        child.stdout.on("error", () => failed(new Error("Saída do serviço Tuya indisponível.")));
        child.stderr.on("error", () => failed(new Error("Diagnóstico do serviço Tuya indisponível.")));
        child.once("error", () => failed(new Error("Não foi possível iniciar o serviço Tuya.")));
        child.once("close", code => {
            lines.close();
            failed(new Error(`Serviço Tuya persistente encerrou com código ${code}.`));
        });
    }

    isReady(): boolean {
        return Boolean(this.child && !this.child.killed && this.ready);
    }

    onFailure(listener: (error: Error) => void): () => void {
        this.failureListeners.add(listener);
        return () => this.failureListeners.delete(listener);
    }

    async waitUntilReady(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        this.start();
        const pending = this.readiness!.promise;
        await timedServiceOperation(signal => awaitServiceOperation(pending, signal), {
            signal, timeoutMs: 10_000, label: "Tuya startup",
        });
    }

    async healthCheck(signal?: AbortSignal): Promise<boolean> {
        signal?.throwIfAborted();
        // Readiness of the owned worker only. Never query or toggle a device
        // for health checks; an in-flight I/O stall is bounded by request().
        return this.isReady();
    }

    private spawnService(): ChildProcessWithoutNullStreams {
        const serviceDir = servicePath("light-tuya");
        const pythonExe = path.join(serviceDir, ".venv", "Scripts", "python.exe");
        const script = path.join(serviceDir, "src", "tuya_daemon.py");
        return spawn(pythonExe, ["-u", script, this.options.mode ?? "light"], {
            cwd: serviceDir,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                PYTHONIOENCODING: "utf-8",
                PYTHONUTF8: "1",
                PYTHONUNBUFFERED: "1",
                ULTRON_TUYA_FAST_CONFIRM:
                    process.env.ULTRON_TUYA_CONFIRM_COMMANDS === "1" ? "0" : "1",
            },
        });
    }

    async request(argumentsList: string[], signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        if (this.pending.size >= 64) throw new Error("Fila Tuya ocupada; tente novamente em instantes.");
        const id = randomUUID();

        return await new Promise<string>((resolve, reject) => {
            const abort = (): void => {
                this.cancelRequest(id, new DOMException("Controle Tuya cancelado.", "AbortError"));
            };
            const removeAbortListener = signal
                ? (): void => signal.removeEventListener("abort", abort)
                : undefined;
            const configuredTimeout = Number(process.env.ULTRON_TUYA_TIMEOUT_MS);
            const timeoutMs = this.options.timeoutMs ?? (
                Number.isFinite(configuredTimeout) && configuredTimeout > 0
                    ? Math.min(60_000, Math.max(500, configuredTimeout))
                    : 15_000
            );
            const timer = setTimeout(() => this.cancelRequest(
                id,
                new Error("Timeout Tuya. Se o comando já foi enviado, o estado precisa ser consultado."),
            ), timeoutMs);
            this.pending.set(id, { id, argumentsList, queuedAt: performance.now(), resolve, reject, timer, removeAbortListener });
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            else this.pump();
        });
    }

    stop(): void {
        if (this.child) this.retire(this.child);
        this.failAll(new Error("Serviço Tuya encerrado."));
    }

    private pump(): void {
        if (this.activeId || this.pending.size === 0) return;
        try {
            this.start();
        } catch {
            this.failAll(new Error("Não foi possível iniciar o serviço Tuya."));
            return;
        }
        const request = this.pending.values().next().value as PendingRequest | undefined;
        const child = this.child;
        if (!request || !child) return;
        this.activeId = request.id;
        request.startedAt = performance.now();
        perf.record("Tuya queue wait", request.startedAt - request.queuedAt);
        // Only the active request crosses stdin. Cancelled queued commands never
        // reach the device; an in-flight mutation is never automatically replayed.
        child.stdin.write(`${JSON.stringify({ id: request.id, arguments: request.argumentsList })}\n`, error => {
            if (!error || this.child !== child) return;
            this.retire(child);
            this.failAll(new Error("Falha ao enviar comando ao serviço Tuya."));
        });
    }

    private retire(child: ChildProcessWithoutNullStreams): void {
        if (this.child === child) {
            this.child = null;
            this.ready = false;
            this.readiness?.reject(new Error("Serviço Tuya encerrado antes de confirmar prontidão."));
            this.readiness = null;
        }
        try { child.kill(); } catch { /* Already exited. */ }
    }

    private cancelRequest(id: string, error: Error): void {
        const request = this.take(id);
        if (!request) return;
        // Killing the worker also bounds a blocked upstream HTTP call. Already
        // accepted device actions cannot be undone by cancellation.
        if (this.activeId === id) {
            this.activeId = null;
            if (this.child) this.retire(this.child);
        }
        request.reject(error);
        this.pump();
    }

    private take(id: string): PendingRequest | undefined {
        const request = this.pending.get(id);
        if (!request) return undefined;
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.removeAbortListener?.();
        return request;
    }

    private handleLine(line: string): void {
        let result: ServiceResult;

        try {
            result = JSON.parse(line) as ServiceResult;
        } catch {
            debugLog("[TUYA] Saída não JSON ignorada.");
            return;
        }

        if (!result || typeof result !== "object") return;
        if (result.type === "ready" && result.mode === (this.options.mode ?? "light")) {
            this.ready = true;
            this.readiness?.resolve();
            return;
        }
        if (typeof result.id !== "string" || result.id !== this.activeId) return;
        const request = this.take(result.id);
        if (!request) return;
        this.activeId = null;
        if (request.startedAt !== undefined) perf.record("Tuya daemon request", performance.now() - request.startedAt);
        if (typeof result.transport_ms === "number" && Number.isFinite(result.transport_ms) && result.transport_ms >= 0) {
            perf.record("Tuya device transport", result.transport_ms);
        }

        if (result.success !== true) {
            request.reject(new Error(result.error ?? "A Tuya recusou o comando."));
        } else {
            const { id: _id, type: _type, ...payload } = result;
            request.resolve(JSON.stringify(payload));
        }
        this.pump();
    }

    private failAll(error: Error): void {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.removeAbortListener?.();
            request.reject(error);
        }
        this.pending.clear();
        this.activeId = null;
    }
}

export const tuyaCloudClient = new TuyaCloudClient();
// Discovery cannot hold the interactive bulb queue while listing cloud devices.
export const tuyaHomeClient = new TuyaCloudClient({ mode: "home" });
