import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";

type SttMessage = | { type: "ready"; } | { type: "wake_detected"; text?: string } | { type: "transcript"; text: string; } | { type: "timeout"; } | { type: "error"; error: string; }

interface PendingListen {
    resolve: (text: string) => void;
    reject: (error: Error) => void;
}

export class SpeechToTextService {
    private child: ChildProcessWithoutNullStreams | null = null;
    private ready = false;

    private pendingListen: PendingListen | null = null;

    async start(): Promise<void> {
        if (this.child) {
            return;
        }

        const ultronRoot = path.resolve(process.cwd(), "..", "..");
        const pythonExecutable = path.join(ultronRoot, "services", "speech-vosk", ".venv", "Scripts", "python.exe");
        const serviceScript = path.join(ultronRoot, "services", "speech-vosk", "src", "stt_service.py");


        return new Promise<void>((resolve, reject) => {
            let startFinished = false;

            const child = spawn(
                pythonExecutable,
                [
                    "-u",
                    serviceScript
                ],
                {
                    stdio: [
                        "pipe",
                        "pipe",
                        "pipe",

                    ],

                    env: {
                        ...process.env,

                        PYTHONIOENCODING: "utf-8",
                        PYTHONUTF8: "1",
                        PYTHONUNBUFFERED: "1"
                    }
                }
            );

            this.child = child;

            const output = createInterface({
                input: child.stdout,
            });

            output.on("line", (line) => {
                const trimmedLine = line.trim();

                if (!trimmedLine) {
                    return;
                }

                let message: SttMessage;

                try {
                    message = JSON.parse(trimmedLine) as SttMessage;
                } catch {
                    console.warn(`[STT] Saída não JSON ${trimmedLine}`);
                    return;
                }

                if (message.type === "ready" && !startFinished) {
                    startFinished = true;
                    this.ready = true;

                    console.log("Sitema de reconhecimento de voz carregado");

                    resolve();

                    return;
                }

                this.handleMessage(message);
            });

            child.stderr.on("data", (data: Buffer) => {
                const text = data.toString("utf8").trim();

                if (text) {
                    console.log(`[STT] ${text}`);
                }
            });

            child.once("error", (error) => {
                this.ready = false;

                if (!startFinished) {
                    startFinished = true;
                    reject(error);
                }

                this.rejectPending(error);
            });

            child.once("close", (code) => {
                this.ready = false;
                this.child = null;

                const error = new Error(`Serviço STT encerrado com código ${code ?? "desconhecido"}`);

                if (!startFinished) {
                    startFinished = true;
                    reject(error);
                }

                this.rejectPending(error);
            });
        });
    }

    listen(): Promise<string> {
        if (!this.child || !this.ready) {
            return Promise.reject(new Error("O serviço de reconhecimento de voz não foi iniciado"));
        }

        if (this.pendingListen) {
            return Promise.reject(new Error("Já existe uma operação de escuta em andamento"));
        }

        return new Promise<string>((resolve, reject) => {
            this.pendingListen = {
                resolve,
                reject
            };

            try {
                this.send({
                    type: "resume"
                });
            } catch (error) {
                this.pendingListen = null;

                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    pause(): void {
        if (!this.child || !this.ready) {
            return;
        }

        this.send({
            type: "pause"
        });
    }

    resume(): void {
        if (!this.child || !this.ready) {
            return;
        }

        this.send({
            type: "resume"
        });
    }

    stop(): void {
        const child = this.child;

        this.ready = false;
        this.child = null;

        if (!child) {
            return;
        }

        try {
            if (child.stdin.writable) {
                child.stdin.write(
                    `${JSON.stringify({
                        type: "stop",
                    })}\n`,
                );
            }
        } catch {

        }

        setTimeout(() => {
            if (!child.killed) {
                child.kill();
            }
        }, 300).unref();

        this.rejectPending(
            new Error(
                "Serviço de reconhecimento de voz encerrado.",
            ),
        );
    }


    private send(
        message: Record<string, unknown>,
    ): void {
        if (
            !this.child
            || !this.child.stdin.writable
        ) {
            throw new Error(
                "Não foi possível enviar uma mensagem ao serviço STT.",
            );
        }

        this.child.stdin.write(
            `${JSON.stringify(message)}\n`,
        );
    }


    private handleMessage(
        message: SttMessage,
    ): void {
        switch (message.type) {
            case "wake_detected": {
                console.log(
                    "\nUltron detectando comandos..."
                );

                break;
            }


            case "transcript": {
                const text = message.text.trim();

                if (!this.pendingListen) {
                    console.warn(
                        `[STT] Transcript recebido sem listener: ${text}`,
                    );

                    return;
                }

                const pending =
                    this.pendingListen;

                this.pendingListen = null;

                pending.resolve(text);

                break;
            }


            case "timeout": {
                this.rejectPending(
                    new Error(
                        "Tempo para falar o comando esgotado.",
                    ),
                );

                break;
            }


            case "error": {
                this.rejectPending(
                    new Error(message.error),
                );

                break;
            }
        }
    }


    private rejectPending(
        error: Error,
    ): void {
        if (!this.pendingListen) {
            return;
        }

        const pending =
            this.pendingListen;

        this.pendingListen = null;

        pending.reject(error);
    }
}