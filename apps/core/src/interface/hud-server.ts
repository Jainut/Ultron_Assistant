import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { runtimeConfig } from "../config/runtime.ts";

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
}

const mimeTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
};

export class HudServer {
    private server: Server | null = null;
    private readonly clients = new Set<ServerResponse>();
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
                const requestUrl = new URL(request.url ?? "/", this.url());

                if (requestUrl.pathname === "/api/events") {
                    response.writeHead(200, {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                        "Access-Control-Allow-Origin": "*",
                    });
                    response.write(`data: ${JSON.stringify(this.snapshot)}\n\n`);
                    this.clients.add(response);
                    request.on("close", () => this.clients.delete(response));
                    return;
                }

                if (requestUrl.pathname === "/api/status") {
                    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
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
                createReadStream(filePath).pipe(response);
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
        const payload = `data: ${JSON.stringify(this.snapshot)}\n\n`;

        for (const client of this.clients) {
            client.write(payload);
        }
    }

    stop(): void {
        for (const client of this.clients) {
            client.end();
        }

        this.clients.clear();
        this.server?.close();
        this.server = null;
    }
}
