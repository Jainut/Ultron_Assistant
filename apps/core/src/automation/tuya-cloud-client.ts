import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";

import { servicePath } from "../config/runtime.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";

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

    constructor(private readonly options: TuyaClientOptions = {}) {}

    start(): void {
        if (this.child) return;
        const child = this.options.spawnProcess?.(this.options.mode ?? "light")
            ?? this.spawnService();
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
        };
        child.stdin.on("error", () => failed(new Error("Canal do serviço Tuya indisponível.")));
        child.once("error", () => failed(new Error("Não foi possível iniciar o serviço Tuya.")));
        child.once("close", code => {
            lines.close();
            failed(new Error(`Serviço Tuya persistente encerrou com código ${code}.`));
        });
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
        if (this.child === child) this.child = null;
        child.kill();
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

        if (!result || typeof result !== "object" || typeof result.id !== "string" || result.id !== this.activeId) return;
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
