import {
    spawn,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { servicePath } from "../config/runtime.ts";
import { serviceError } from "../utils/debug.ts";

interface PendingRequest {
    resolve: (audioPath: string) => void;
    reject: (error: Error) => void;
    startedAt: number;
    removeAbortListener?: () => void;
}

interface ServiceMessage {
    id?: string;
    type: "ready" | "audio_ready" | "error";
    path?: string;
    error?: string;
}

const ttsRoot = servicePath("tts-kokoro");

const pythonExecutable = path.join(
    ttsRoot,
    ".venv",
    "Scripts",
    "python.exe",
);

const ttsServiceScript = path.join(
    ttsRoot,
    "src",
    "tts_service.py",
);

const outputDirectory = path.join(
    ttsRoot,
    "output",
);

export class TextToSpeechService {
    private child: ChildProcessWithoutNullStreams | null = null;

    private ready = false;

    private readonly pending = new Map<
        string,
        PendingRequest
    >();

    start(): Promise<void> {
        if (this.child) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            let startupSettled = false;

            this.child = spawn(
                pythonExecutable,
                [
                    "-u",
                    ttsServiceScript,
                ],
                {
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    env: {
                        ...process.env,
                        PYTHONIOENCODING: "utf-8",
                        PYTHONUTF8: "1",
                        PYTHONUNBUFFERED: "1",

                        HF_HUB_VERBOSITY: "error",
                        PYTHONWARNINGS: "ignore::UserWarning,ignore::FutureWarning",
                    },
                },
            );

            const lines = createInterface({
                input: this.child.stdout,
            });

            lines.on("line", (line) => {
                this.handleMessage(line, () => {
                    startupSettled = true;
                    resolve();
                });
            });

            this.child.stderr.on("data", (chunk: Buffer) => {
                serviceError("[Kokoro]", chunk.toString());
            });

            this.child.once("error", (error) => {
                startupSettled = true;
                reject(error);
            });

            this.child.once("close", (code) => {
                this.ready = false;
                this.child = null;

                const error = new Error(
                    `O serviço Kokoro encerrou com código ${code}.`,
                );

                if (!startupSettled) {
                    startupSettled = true;
                    reject(error);
                }

                for (const request of this.pending.values()) {
                    request.reject(error);
                }

                this.pending.clear();
            });
        });
    }

    private handleMessage(
        line: string,
        resolveStart: () => void,
    ): void {
        let message: ServiceMessage;

        try {
            message = JSON.parse(line) as ServiceMessage;
        } catch {
            return;
        }

        if (message.type === "ready") {
            this.ready = true;
            resolveStart();
            return;
        }

        if (!message.id) {
            return;
        }

        const request = this.pending.get(message.id);

        if (!request) {
            return;
        }

        this.pending.delete(message.id);
        request.removeAbortListener?.();

        const elapsed =
            (performance.now() - request.startedAt) / 1000;


        if (message.type === "audio_ready" && message.path) {
            request.resolve(message.path);
            return;
        }

        request.reject(
            new Error(
                message.error ??
                "O serviço não conseguiu gerar a fala.",
            ),
        );
    }

    async synthesize(text: string, signal?: AbortSignal): Promise<string> {
        if (!text.trim()) {
            throw new Error("O texto da fala está vazio.");
        }

        if (!this.child || !this.ready) {
            throw new Error(
                "O serviço de voz ainda não está pronto.",
            );
        }

        const id = randomUUID();

        const audioPath = path.join(
            outputDirectory,
            `speech-${id}.wav`,
        );

        signal?.throwIfAborted();

        return new Promise((resolve, reject) => {
            const abort = (): void => {
                const request = this.pending.get(id);

                if (!request) {
                    return;
                }

                this.pending.delete(id);
                this.child?.stdin.write(`${JSON.stringify({
                    id,
                    type: "cancel",
                })}\n`);
                reject(new DOMException("Síntese cancelada.", "AbortError"));
            };
            const removeAbortListener = signal
                ? (): void => signal.removeEventListener("abort", abort)
                : undefined;

            this.pending.set(id, {
                resolve,
                reject,
                startedAt: performance.now(),
                removeAbortListener,
            });

            signal?.addEventListener("abort", abort, { once: true });

            const message = {
                id,
                type: "speak",
                text,
                output: audioPath,
            };

            this.child?.stdin.write(
                `${JSON.stringify(message)}\n`,
            );
        });
    }

    stop(): void {
        if (!this.child) {
            return;
        }

        const error = new Error("O serviço de voz foi encerrado.");

        for (const request of this.pending.values()) {
            request.removeAbortListener?.();
            request.reject(error);
        }

        this.pending.clear();
        this.child.stdin.end();
        this.child.kill();
        this.child = null;
        this.ready = false;
    }
}
