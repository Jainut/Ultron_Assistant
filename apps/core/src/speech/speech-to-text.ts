import {
    spawn,
    type ChildProcessByStdio,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { Readable } from "node:stream";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { runtimeConfig, servicePath } from "../config/runtime.ts";
import { debugLog, serviceError } from "../utils/debug.ts";


interface CaptureMessage {
    type:
    | "ready"
    | "speech_start"
    | "audio"
    | "error";

    path?: string;
    error?: string;
}


export class SpeechToTextService {
    private readonly speechStartListeners =
        new Set<() => void>();
    private whisperProcess: ChildProcessByStdio<null, Readable, Readable> | null = null;
    private captureProcess: ChildProcessWithoutNullStreams | null = null;

    private captureReady = false;

    private pendingResolve: ((text: string) => void) | null = null;
    private pendingReject: ((error: Error) => void) | null = null;


    private readonly whisperPort = runtimeConfig.whisperPort;

    private readonly whisperUrl =
        `http://127.0.0.1:${this.whisperPort}/inference`;


    onSpeechStart(
        listener: () => void,
    ): () => void {
        this.speechStartListeners.add(
            listener,
        );

        return () => {
            this.speechStartListeners.delete(
                listener,
            );
        };
    }

    async start(): Promise<void> {
        const whisperDir = servicePath("speech-whisper");

        const whisperExe = path.join(
            whisperDir,
            "build",
            "bin",
            "whisper-server.exe",
        );

        const modelPath = path.join(
            whisperDir,
            runtimeConfig.whisperModel,
        );

        const captureDir = servicePath("speech-input");

        const pythonExe = path.join(
            captureDir,
            ".venv",
            "Scripts",
            "python.exe",
        );

        const captureScript = path.join(
            captureDir,
            "src",
            "capture_service.py",
        );


        const whisperProcess = spawn(
            whisperExe,
            [
                "-m",
                modelPath,

                "--host",
                "127.0.0.1",

                "--port",
                String(this.whisperPort),

                "-l",
                "pt",

                "-t",
                    String(runtimeConfig.whisperThreads),

                "-fa",

                "-nt",

                "--prompt",
                [
                    "Ultron",
                    "Ollama",
                    "Kokoro",
                    "TypeScript",
                    "JavaScript",
                    "Visual Studio Code",
                    "VS Code",
                    "Zen Browser",
                    "PowerShell",
                ].join(", "),
            ],
            {
                cwd: whisperDir,
                windowsHide: true,
                stdio: [
                    "ignore",
                    "pipe",
                    "pipe",
                ],
            },
        );

        this.whisperProcess = whisperProcess;


        whisperProcess.on(
            "exit",
            (code) => {
                if (code !== 0) {
                    console.error(
                        `[Whisper] servidor encerrado com código ${code}`
                    );
                }
            },
        );


        await this.waitForWhisper();


        this.captureProcess = spawn(
            pythonExe,
            [
                "-u",
                captureScript,
            ],
            {
                cwd: captureDir,

                env: {
                    ...process.env,

                    PYTHONIOENCODING: "utf-8",
                    PYTHONUTF8: "1",
                    PYTHONUNBUFFERED: "1",
                },

                windowsHide: true,
                stdio: [
                    "pipe",
                    "pipe",
                    "pipe",
                ],
            },
        );


        this.captureProcess.stderr.on(
            "data",
            (data) => {
                const text = data
                    .toString()
                    .trim();

                if (text) {
                    serviceError("[STT]", text);
                }
            },
        );


        let buffer = "";

        this.captureProcess.stdout.on(
            "data",
            (data) => {
                buffer += data.toString();

                const lines = buffer.split(
                    "\n"
                );

                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    const trimmed = line.trim();

                    if (!trimmed) {
                        continue;
                    }

                    try {
                        const message =
                            JSON.parse(
                                trimmed
                            ) as CaptureMessage;

                        void this.handleCaptureMessage(
                            message
                        );

                    } catch {
                        // Ignora saída não JSON.
                    }
                }
            },
        );


        await this.waitForCapture();
    }


    private async waitForWhisper(): Promise<void> {
        const deadline =
            Date.now() + 60_000;

        while (Date.now() < deadline) {
            try {
                const response = await fetch(
                    `http://127.0.0.1:${this.whisperPort}/`
                );

                if (response.ok) {
                    return;
                }

            } catch {
                // Ainda carregando o modelo.
            }

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        250,
                    )
            );
        }

        throw new Error(
            "Whisper Server não iniciou dentro do tempo esperado."
        );
    }


    private async waitForCapture(): Promise<void> {
        const deadline =
            Date.now() + 10_000;

        while (Date.now() < deadline) {
            if (this.captureReady) {
                return;
            }

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        50,
                    )
            );
        }

        throw new Error(
            "Serviço de captura de áudio não iniciou."
        );
    }


    private async handleCaptureMessage(
        message: CaptureMessage,
    ): Promise<void> {
        if (
            message.type ===
            "ready"
        ) {
            this.captureReady =
                true;

            return;
        }

        if (
            message.type ===
            "speech_start"
        ) {
            debugLog(
                "[BARGE] speech_start recebido do Python."
            );

            for (
                const listener
                of this.speechStartListeners
            ) {
                listener();
            }

            return;
        }

        if (
            message.type ===
            "error"
        ) {
            const error =
                new Error(
                    message.error
                    ?? "Erro desconhecido na captura."
                );

            this.pendingReject?.(
                error
            );

            this.clearPending();

            return;
        }

        if (
            message.type ===
            "audio"
            && message.path
        ) {
            try {
                const text =
                    await this.transcribe(
                        message.path
                    );


                if (!text) {
                    this.sendCapture({
                        type: "resume",
                    });

                    return;
                }


                this.pendingResolve?.(
                    text
                );

                this.clearPending();

            } catch (error) {
                const normalizedError =
                    error instanceof Error
                        ? error
                        : new Error(
                            String(error)
                        );


                this.pendingReject?.(
                    normalizedError
                );


                this.clearPending();
            }
        }
    }


    private async transcribe(
        audioPath: string
    ): Promise<string> {
        try {
            const audio = await readFile(
                audioPath
            );

            const form = new FormData();

            form.append(
                "file",
                new Blob(
                    [audio],
                    {
                        type: "audio/wav",
                    },
                ),
                path.basename(
                    audioPath
                ),
            );

            form.append(
                "language",
                "pt"
            );

            form.append(
                "temperature",
                "0.0"
            );

            form.append(
                "response_format",
                "text"
            );

            form.append(
                "no_timestamps",
                "true"
            );

            form.append(
                "suppress_non_speech",
                "true"
            );

            form.append(
                "prompt",
                [
                    "Ultron",
                    "Ollama",
                    "Kokoro",
                    "TypeScript",
                    "JavaScript",
                    "Visual Studio Code",
                    "VS Code",
                    "Zen Browser",
                    "PowerShell",
                ].join(", "),
            );


            const response = await fetch(
                this.whisperUrl,
                {
                    method: "POST",
                    body: form,
                },
            );


            if (!response.ok) {
                const body =
                    await response.text();

                throw new Error(
                    `Whisper respondeu ${response.status}: ${body}`
                );
            }


            const text =
                await response.text();

            return text.trim();

        } finally {
            await unlink(
                audioPath
            ).catch(
                () => undefined
            );
        }
    }


    listen(): Promise<string> {
        if (!this.captureProcess) {
            return Promise.reject(
                new Error(
                    "Serviço STT não iniciado."
                )
            );
        }


        if (this.pendingResolve) {
            return Promise.reject(
                new Error(
                    "Já existe uma escuta STT pendente."
                )
            );
        }


        return new Promise<string>(
            (resolve, reject) => {
                this.pendingResolve =
                    resolve;

                this.pendingReject =
                    reject;

                this.sendCapture({
                    type: "resume",
                });
            },
        );
    }


    pause(): void {
        this.sendCapture({
            type: "pause",
        });
    }


    resume(): void {
        this.sendCapture({
            type: "resume",
        });
    }


    private sendCapture(
        message: object
    ): void {
        if (
            !this.captureProcess
            || this.captureProcess.killed
        ) {
            return;
        }

        this.captureProcess.stdin.write(
            JSON.stringify(
                message
            ) + "\n"
        );
    }


    private clearPending(): void {
        this.pendingResolve = null;
        this.pendingReject = null;
    }


    stop(): void {
        this.sendCapture({
            type: "stop",
        });

        this.captureProcess?.kill();
        this.whisperProcess?.kill();

        this.captureProcess = null;
        this.whisperProcess = null;

        this.captureReady = false;

        this.clearPending();
    }
}
