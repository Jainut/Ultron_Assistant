import type { ServiceSnapshot, ServiceState } from "./service-supervisor.ts";
import { ServiceSupervisor } from "./service-supervisor.ts";
import { timedServiceOperation } from "./service-lifecycle.ts";

const publicServiceNames = new Set([
    "stt", "tts", "tuya", "tuya-home", "automation", "ollama", "gmail", "google-tasks", "google-calendar",
]);

export interface PublicServiceHealth {
    name: string;
    state: ServiceState;
    attempts: number;
    restarts: number;
}

/** Public health never contains paths, transcripts, provider errors or tokens. */
export function publicServiceHealth(snapshots: readonly ServiceSnapshot[]): PublicServiceHealth[] {
    return snapshots.filter(item => publicServiceNames.has(item.name)).map(item => ({
        name: item.name,
        state: item.state,
        attempts: item.attempts,
        restarts: item.restarts,
    }));
}

export function runtimeHealthSummary(snapshots: readonly ServiceSnapshot[]): {
    phase: "starting" | "ready" | "degraded";
    detail: string;
} {
    const voice = snapshots.filter(item => item.name === "stt" || item.name === "tts");
    const unavailable = snapshots.filter(item => item.state === "failed" || item.state === "degraded"
        || item.state === "restarting" || (item.state === "stopped" && item.attempts > 0));
    if (unavailable.length) {
        return { phase: "degraded", detail: `Serviços indisponíveis ou recuperando: ${unavailable.map(item => item.name).join(", ")}. Comandos pelo terminal continuam disponíveis.` };
    }
    if (voice.length < 2 || voice.some(item => item.state !== "ready")) {
        return { phase: "starting", detail: "Carregando voz. Comandos pelo terminal já estão disponíveis." };
    }
    const pending = snapshots.filter(item => item.state === "starting" || item.state === "stopped");
    if (pending.length) {
        return { phase: "starting", detail: `Voz pronta; inicializando: ${pending.map(item => item.name).join(", ")}. Comandos pelo terminal disponíveis.` };
    }
    return { phase: "ready", detail: "Voz e tools prontas. Integrações não configuradas permanecem opcionais." };
}

/** Waits without polling/spinning while IPC/terminal continue to accept input. */
export function waitForServiceReady(
    supervisor: ServiceSupervisor, name: string, signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    if (supervisor.snapshot(name).state === "ready") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const cleanup = (): void => { unsubscribe(); signal.removeEventListener("abort", abort); };
        const abort = (): void => { cleanup(); reject(signal.reason); };
        const check = (): void => {
            if (supervisor.snapshot(name).state === "ready") { cleanup(); resolve(); }
        };
        const unsubscribe = supervisor.onStateChange(snapshot => { if (snapshot.name === name) check(); });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else check();
    });
}

/** The installed Ollama client uses this loopback host. No model is loaded here. */
export async function checkLocalOllamaHealth(
    model: string, signal?: AbortSignal, transport: typeof fetch = fetch,
): Promise<boolean> {
    return timedServiceOperation(async signal => {
        const response = await transport("http://127.0.0.1:11434/api/tags", { signal, redirect: "error" });
        if (!response.ok) return false;
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !("models" in body) || !Array.isArray(body.models)) return false;
        return body.models.some((item: unknown) => {
            if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") return false;
            return item.name === model || item.name === `${model}:latest`;
        });
    }, { signal, timeoutMs: 2_000, label: "Ollama health" });
}
