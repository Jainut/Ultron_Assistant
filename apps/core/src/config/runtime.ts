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

function booleanFromEnv(name: string, fallback: boolean): boolean {
    const configured = process.env[name]?.trim().toLowerCase();
    if (!configured) return fallback;
    if (["1", "true", "yes", "on"].includes(configured)) return true;
    if (["0", "false", "no", "off"].includes(configured)) return false;
    return fallback;
}

const defaultWhisperTerms = [
    "Ultron", "Ollama", "Kokoro", "Visual Studio Code", "VS Code",
    "Zen Browser", "Spotify", "YouTube", "GitHub", "Supabase",
    "Vercel", "Render", "Node.js", "TypeScript", "JavaScript", "PowerShell",
];

const legacyEndpointTargetMs = numberFromEnv(
    "ULTRON_SILENCE_SECONDS",
    Number.NaN,
) * 1_000;
const legacyMinimumVoicedMs = numberFromEnv(
    "ULTRON_MIN_SPEECH_SECONDS",
    Number.NaN,
) * 1_000;

/**
 * Prefere o melhor equilíbrio medido nesta máquina sem quebrar instalações
 * existentes: o Turbo quantizado só vira padrão quando já está disponível.
 */
export function selectDefaultWhisperModel(projectRoot: string): string {
    const whisperDirectory = path.join(projectRoot, "services", "speech-whisper");
    const candidates = [
        "ggml-large-v3-turbo-q5_0.bin",
        "ggml-medium.bin",
        "ggml-small.bin",
    ];

    return candidates.find(model => existsSync(path.join(whisperDirectory, model)))
        ?? "ggml-medium.bin";
}

const projectRoot = findProjectRoot();

export const runtimeConfig = {
    projectRoot,
    ollamaModel: process.env.ULTRON_MODEL?.trim() || "qwen3:4b-instruct",
    whisperModel: process.env.ULTRON_WHISPER_MODEL?.trim()
        || selectDefaultWhisperModel(projectRoot),
    whisperThreads: integerFromEnv("ULTRON_WHISPER_THREADS", 4),
    whisperLanguage: process.env.ULTRON_WHISPER_LANGUAGE?.trim() || "pt",
    whisperBeamSize: integerFromEnv("ULTRON_WHISPER_BEAM_SIZE", 2),
    whisperBestOf: integerFromEnv("ULTRON_WHISPER_BEST_OF", 2),
    whisperTemperature: numberFromEnv("ULTRON_WHISPER_TEMPERATURE", 0),
    whisperNoSpeechThreshold: numberFromEnv("ULTRON_WHISPER_NO_SPEECH_THRESHOLD", 0.5),
    sttEndpointMinMs: numberFromEnv("ULTRON_ENDPOINT_MIN_MS", 280),
    sttEndpointTargetMs: numberFromEnv(
        "ULTRON_ENDPOINT_TARGET_MS",
        Number.isFinite(legacyEndpointTargetMs) ? legacyEndpointTargetMs : 320,
    ),
    sttEndpointMaxMs: numberFromEnv("ULTRON_ENDPOINT_MAX_MS", 400),
    sttMinimumVoicedMs: numberFromEnv(
        "ULTRON_MIN_VOICED_MS",
        Number.isFinite(legacyMinimumVoicedMs) ? legacyMinimumVoicedMs : 120,
    ),
    sttVadEnabled: booleanFromEnv("ULTRON_VAD_ENABLED", true),
    sttVadMode: integerFromEnv("ULTRON_VAD_MODE", 2),
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
