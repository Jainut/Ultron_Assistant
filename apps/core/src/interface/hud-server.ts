import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { runtimeConfig } from "../config/runtime.ts";
import type { PublicServiceHealth } from "../system/runtime-health.ts";

export type HudState =
    | "booting"
    | "listening"
    | "thinking"
    | "speaking"
    | "sleeping"
    | "error";

export interface HudSnapshot {
    state: HudState;
    message: string;
    transcript?: string;
    response?: string;
    timings?: Record<string, number>;
    services?: PublicServiceHealth[];
}

const mimeTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
};

const serviceNames = new Set([
    "stt", "tts", "tuya", "tuya-home", "automation", "ollama", "gmail", "google-tasks", "google-calendar",
]);
const serviceStates = new Set(["starting", "ready", "degraded", "restarting", "failed", "stopped"]);

function safeServiceHealth(value: unknown): PublicServiceHealth[] {
    if (!Array.isArray(value)) return [];
    const services: PublicServiceHealth[] = [];
    const seen = new Set<string>();
    for (const entry of value.slice(0, 64)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)
            || typeof entry.name !== "string" || !serviceNames.has(entry.name) || seen.has(entry.name)
            || typeof entry.state !== "string" || !serviceStates.has(entry.state)
            || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0
            || !Number.isSafeInteger(entry.restarts) || entry.restarts < 0) continue;
        seen.add(entry.name);
        // Structural typing also accepts ServiceSnapshot[] here. Never forward
        // its lastFailure, paths or provider payloads to the browser by accident.
        services.push({ name: entry.name, state: entry.state as PublicServiceHealth["state"],
            attempts: entry.attempts, restarts: entry.restarts });
    }
    return services;
}

export class HudServer {
    private server: Server | null = null;
    private readonly clients = new Set<ServerResponse>();
    private readonly clientVersions = new WeakMap<ServerResponse, number>();
    private snapshotVersion = 0;
    private broadcastTimer: NodeJS.Timeout | null = null;
    private snapshot: HudSnapshot = {
        state: "booting",
        message: "Inicializando sistemas",
    };

    constructor(private port = runtimeConfig.hudPort) {}

    url(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    openInBrowser(): void {
        if (process.env.ULTRON_OPEN_HUD === "0") {
            return;
        }

        const child = spawn(
            "cmd.exe",
            ["/c", "start", "", this.url()],
            { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.unref();
    }

    start(): Promise<void> {
        if (this.server) {
            return Promise.resolve();
        }

        const uiRoot = path.join(runtimeConfig.projectRoot, "apps", "core", "ui");

        return new Promise((resolve, reject) => {
            const server = createServer((request, response) => {
                response.setHeader("X-Content-Type-Options", "nosniff");
                const deny = (status: number, message: string): void => {
                    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
                    response.end(message);
                };
                const host = request.headers.host?.toLowerCase();
                const allowedHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
                if (this.port === 80) { allowedHosts.add("127.0.0.1"); allowedHosts.add("localhost"); }
                // Loopback binding alone does not stop DNS rebinding: browsers
                // must not access private snapshots under an external Host.
                if (!host || !allowedHosts.has(host)) {
                    deny(403, "Host not allowed");
                    return;
                }
                const requestOrigin = new URL(`http://${host}`).origin;

                // Transcripts are local/private: a third-party page cannot read
                // this loopback API through a permissive CORS response.
                if (request.headers.origin !== undefined && request.headers.origin !== requestOrigin) {
                    deny(403, "Origin not allowed");
                    return;
                }
                let requestUrl: URL;
                try {
                    requestUrl = new URL(request.url ?? "/", requestOrigin);
                } catch {
                    deny(400, "Invalid URL");
                    return;
                }
                if (requestUrl.origin !== requestOrigin || requestUrl.username || requestUrl.password) {
                    deny(403, "URL origin not allowed");
                    return;
                }

                if (requestUrl.pathname === "/api/events") {
                    response.writeHead(200, {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-store",
                        Connection: "keep-alive",
                        "X-Content-Type-Options": "nosniff",
                    });
                    response.write(`data: ${JSON.stringify(this.snapshot)}\n\n`);
                    this.clientVersions.set(response, this.snapshotVersion);
                    this.clients.add(response);
                    request.on("close", () => this.clients.delete(response));
                    response.on("error", () => this.clients.delete(response));
                    response.on("drain", () => this.writeSnapshot(response));
                    return;
                }

                if (requestUrl.pathname === "/api/status") {
                    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
                    response.end(JSON.stringify(this.snapshot));
                    return;
                }

                const relative = requestUrl.pathname === "/"
                    ? "index.html"
                    : requestUrl.pathname.slice(1);
                const filePath = path.resolve(uiRoot, relative);

                if (!filePath.startsWith(`${path.resolve(uiRoot)}${path.sep}`) || !existsSync(filePath)) {
                    response.writeHead(404);
                    response.end("Not found");
                    return;
                }

                response.writeHead(200, {
                    "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
                });
                const stream = createReadStream(filePath);
                stream.on("error", () => response.destroy());
                stream.pipe(response);
            });

            let remainingPorts = 10;

            const handleListenError = (error: NodeJS.ErrnoException): void => {
                if (error.code === "EADDRINUSE" && remainingPorts > 0) {
                    remainingPorts -= 1;
                    this.port += 1;
                    server.once("error", handleListenError);
                    server.listen(this.port, "127.0.0.1");
                    return;
                }

                reject(error);
            };

            server.once("error", handleListenError);
            server.once("listening", () => {
                this.server = server;
                resolve();
            });
            server.listen(this.port, "127.0.0.1");
        });
    }

    update(update: Partial<HudSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...update };
        if (Object.hasOwn(update, "services")) this.snapshot.services = safeServiceHealth(update.services);
        this.snapshotVersion += 1;
        if (this.broadcastTimer || this.clients.size === 0) return;

        // Streaming token bursts only need the latest snapshot per frame batch.
        // /api/status and new SSE clients still receive the latest state now.
        this.broadcastTimer = setTimeout(() => {
            this.broadcastTimer = null;
            for (const client of this.clients) this.writeSnapshot(client);
        }, 40);
        this.broadcastTimer.unref();
    }

    private writeSnapshot(client: ServerResponse): void {
        if (client.destroyed || client.writableEnded) {
            this.clients.delete(client);
            return;
        }
        // Do not accumulate every intermediate token for a slow/hidden client.
        // Its drain callback will send the latest complete snapshot instead.
        if (client.writableNeedDrain) return;
        if (this.clientVersions.get(client) === this.snapshotVersion) return;
        this.clientVersions.set(client, this.snapshotVersion);
        client.write(`data: ${JSON.stringify(this.snapshot)}\n\n`);
    }

    stop(): void {
        if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
        this.broadcastTimer = null;
        for (const client of this.clients) {
            client.end();
        }

        this.clients.clear();
        this.server?.close();
        this.server = null;
    }
}
