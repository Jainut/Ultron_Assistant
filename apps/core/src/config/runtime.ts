import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findProjectRoot(): string {
    const configuredRoot = process.env.ULTRON_ROOT?.trim();

    if (configuredRoot) {
        return path.resolve(configuredRoot);
    }

    let current = path.dirname(fileURLToPath(import.meta.url));

    while (true) {
        if (
            existsSync(path.join(current, "apps", "core"))
            && existsSync(path.join(current, "services"))
        ) {
            return current;
        }

        const parent = path.dirname(current);

        if (parent === current) {
            throw new Error(
                "Não foi possível localizar a raiz do projeto Ultron.",
            );
        }

        current = parent;
    }
}

function integerFromEnv(name: string, fallback: number): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function numberFromEnv(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) ? parsed : fallback;
}

const defaultWhisperTerms = [
    "Ultron", "Ollama", "Kokoro", "Visual Studio Code", "VS Code",
    "Zen Browser", "Spotify", "YouTube", "GitHub", "Supabase",
    "Vercel", "Render", "Node.js", "TypeScript", "JavaScript", "PowerShell",
];

export const runtimeConfig = {
    projectRoot: findProjectRoot(),
    ollamaModel: process.env.ULTRON_MODEL?.trim() || "qwen3:4b-instruct",
    whisperModel: process.env.ULTRON_WHISPER_MODEL?.trim() || "ggml-medium.bin",
    whisperThreads: integerFromEnv("ULTRON_WHISPER_THREADS", 4),
    whisperLanguage: process.env.ULTRON_WHISPER_LANGUAGE?.trim() || "pt",
    whisperBeamSize: integerFromEnv("ULTRON_WHISPER_BEAM_SIZE", 2),
    whisperBestOf: integerFromEnv("ULTRON_WHISPER_BEST_OF", 2),
    whisperTemperature: numberFromEnv("ULTRON_WHISPER_TEMPERATURE", 0),
    whisperNoSpeechThreshold: numberFromEnv("ULTRON_WHISPER_NO_SPEECH_THRESHOLD", 0.5),
    whisperTerms: process.env.ULTRON_WHISPER_TERMS
        ?.split(/[,;]/)
        .map(value => value.trim())
        .filter(Boolean)
        ?? defaultWhisperTerms,
    whisperPort: integerFromEnv("ULTRON_WHISPER_PORT", 8178),
    hudPort: integerFromEnv("ULTRON_HUD_PORT", 8787),
};

export function servicePath(...segments: string[]): string {
    return path.join(runtimeConfig.projectRoot, "services", ...segments);
}
