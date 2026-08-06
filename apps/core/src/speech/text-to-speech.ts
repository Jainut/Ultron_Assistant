import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

export interface TextToSpeechResult {
    success: boolean;
    audioPath?: string;
    error?: string;
}

const ultronRoot = path.resolve(process.cwd(), "..", "..");
const ttsRoot = path.join(ultronRoot, "services", "tts-kokoro");
const pythonExecutable = path.join(ttsRoot, ".venv", "Scripts", "python.exe",);
const ttsScript = path.join(ttsRoot, "src", "tts_cli.py");
const outputDirectory = path.join(ttsRoot, "output");

console.log({ ultronRoot, pythonExecutable, ttsScript, outputDirectory });

export function synthesizeSpeech(text: string): Promise<TextToSpeechResult> {
    if (!text.trim()) {
        return Promise.resolve({
            success: false,
            error: "O texto da fala está vazio.",
        });
    }

    const audioPath = path.join(outputDirectory, `speech-${randomUUID()}.wav`)

    return new Promise((resolve) => {
        const child = spawn(
            pythonExecutable, 
            [
                ttsScript,
                "--text",
                text,
                "--output",
                audioPath,
            ],
            {
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.once("error", (error) => {
            resolve({
                success: false,
                error: `Não foi possível iniciar o serviço de voz ${error.message}`
            });
        });

        child.once("close", async (code) => {
            if (code !== 0) {
                resolve({
                    success: false,
                    error:
                    stderr.trim() || `O serviço de voz encerrou com código ${code}`
                });

                return
            }

            try {
                await access(audioPath);
                console.log(stdout.trim());

                resolve({
                    success: true,
                    audioPath
                });
            } catch {
                resolve({
                    success: false,
                    error: "O Python encerrou sem gerar o arquivo de áudio"
                });
            }
        });
    });
}