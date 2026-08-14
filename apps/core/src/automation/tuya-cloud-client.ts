import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";

import { servicePath } from "../config/runtime.ts";
import { debugLog, serviceError } from "../utils/debug.ts";

type PendingRequest = {
    resolve: (result: string) => void;
    reject: (error: Error) => void;
    removeAbortListener?: () => void;
};

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

    start(): void {
        if (this.child) return;
        const serviceDir = servicePath("light-tuya");
        const pythonExe = path.join(serviceDir, ".venv", "Scripts", "python.exe");
        const script = path.join(serviceDir, "src", "light_service.py");
        const child = spawn(pythonExe, ["-u", script, "--cloud-server"], {
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
        this.child = child;
        const lines = createInterface({ input: child.stdout });
        lines.on("line", line => this.handleLine(line));
        child.stderr.on("data", data => serviceError("[TUYA]", data.toString()));
        child.once("error", error => this.failAll(error));
        child.once("close", code => {
            this.child = null;
            this.failAll(new Error(`Serviço Tuya persistente encerrou com código ${code}.`));
        });
    }

    async request(argumentsList: string[], signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        this.start();
        const child = this.child;

        if (!child) throw new Error("Serviço Tuya persistente indisponível.");
        const id = randomUUID();

        return await new Promise<string>((resolve, reject) => {
            const abort = (): void => {
                const request = this.pending.get(id);
                if (!request) return;
                this.pending.delete(id);
                reject(new DOMException("Controle da lâmpada cancelado.", "AbortError"));
            };
            const removeAbortListener = signal
                ? (): void => signal.removeEventListener("abort", abort)
                : undefined;
            this.pending.set(id, { resolve, reject, removeAbortListener });
            signal?.addEventListener("abort", abort, { once: true });
            child.stdin.write(`${JSON.stringify({ id, arguments: argumentsList })}\n`);
        });
    }

    stop(): void {
        this.child?.kill();
        this.child = null;
        this.failAll(new Error("Serviço Tuya encerrado."));
    }

    private handleLine(line: string): void {
        let result: ServiceResult;

        try {
            result = JSON.parse(line) as ServiceResult;
        } catch {
            debugLog("[TUYA] Saída não JSON ignorada.");
            return;
        }

        if (!result.id) return;
        const request = this.pending.get(result.id);
        if (!request) return;
        this.pending.delete(result.id);
        request.removeAbortListener?.();

        if (result.success === false) {
            request.reject(new Error(result.error ?? "A Tuya recusou o comando."));
        } else {
            const { id: _id, type: _type, ...payload } = result;
            request.resolve(JSON.stringify(payload));
        }
    }

    private failAll(error: Error): void {
        for (const request of this.pending.values()) {
            request.removeAbortListener?.();
            request.reject(error);
        }
        this.pending.clear();
    }
}

export const tuyaCloudClient = new TuyaCloudClient();
