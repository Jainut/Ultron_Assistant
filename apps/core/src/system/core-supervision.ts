import type { ManagedProvider } from "../providers/provider-manager.ts";
import { setTimeout as delay } from "node:timers/promises";
import { perf } from "../utils/performance.ts";
import { ServiceSupervisor } from "./service-supervisor.ts";

interface VoiceService {
    start(signal?: AbortSignal): Promise<void>;
    stop(): void;
    healthCheck(signal?: AbortSignal): Promise<boolean>;
    onFailure(listener: (error: Error) => void): () => void;
}

interface DeviceWorker {
    waitUntilReady(signal?: AbortSignal): Promise<void>;
    stop(): void;
    healthCheck(signal?: AbortSignal): Promise<boolean>;
    onFailure(listener: (error: Error) => void): () => void;
}

export interface CoreSupervisionOptions {
    stt: VoiceService;
    tts: VoiceService;
    tuya: DeviceWorker;
    tuyaHome: DeviceWorker;
    legacyLightProcess?: boolean;
    discoveryDisabled?: boolean;
    automation: { start(signal?: AbortSignal): Promise<void>; stop(): Promise<void>; isRunning(): boolean };
    ollamaHealth(signal: AbortSignal): Promise<boolean>;
    providers?: Partial<Record<"gmail" | "google-tasks" | "google-calendar", ManagedProvider>>;
}

/** Registration has no I/O; startup order stays under the existing main loop. */
export function createCoreSupervision(options: CoreSupervisionOptions): {
    supervisor: ServiceSupervisor;
    backgroundServices: string[];
} {
    const supervisor = new ServiceSupervisor();
    for (const [name, service] of [["stt", options.stt], ["tts", options.tts]] as const) {
        supervisor.register({
            name,
            start: signal => perf.measure(`${name.toUpperCase()} startup`, () => service.start(signal)),
            stop: () => service.stop(),
            health: signal => service.healthCheck(signal),
            onFailure: listener => service.onFailure(listener),
            policy: { startupTimeoutMs: 180_000, maxRestarts: 2, backoffMs: 1_000 },
        });
    }

    const backgroundServices: string[] = [];
    const workers = [
        ...(!options.legacyLightProcess ? [["tuya", options.tuya] as const] : []),
        ...(!options.discoveryDisabled ? [["tuya-home", options.tuyaHome] as const] : []),
    ];
    for (const [name, worker] of workers) {
        supervisor.register({
            name, start: signal => worker.waitUntilReady(signal), stop: () => worker.stop(),
            health: signal => worker.healthCheck(signal), onFailure: listener => worker.onFailure(listener),
            policy: { startupTimeoutMs: 12_000, maxRestarts: 2, probeWhenFailed: true },
        });
        backgroundServices.push(name);
    }
    supervisor.register({
        name: "automation", start: signal => options.automation.start(signal), stop: () => options.automation.stop(),
        health: () => options.automation.isRunning(), policy: { startupTimeoutMs: 15_000, maxRestarts: 2 },
    });
    supervisor.register({
        name: "ollama", start: async () => undefined, stop: () => undefined,
        health: options.ollamaHealth,
        // Ollama belongs to the user's installation, not this process. Recovery
        // probes only read its catalog; never start/kill/pull a model here.
        policy: { healthTimeoutMs: 2_500, maxRestarts: 0, probeWhenFailed: true },
    });
    backgroundServices.push("automation", "ollama");
    for (const [name, provider] of Object.entries(options.providers ?? {})) {
        if (!provider?.healthCheck) continue;
        supervisor.register({
            name, start: async () => undefined, stop: () => undefined,
            health: async signal => (await provider.healthCheck!({ signal })).status === "ready",
            // OAuth is non-interactive here and mutations are never replayed.
            policy: { healthTimeoutMs: 8_000, healthIntervalMs: 300_000, maxRestarts: 0, probeWhenFailed: true },
        });
        backgroundServices.push(name);
    }
    return { supervisor, backgroundServices };
}

/** Voice starts first, but a missing microphone must not indefinitely block jobs. */
export function startCoreServices(options: {
    supervisor: ServiceSupervisor;
    backgroundServices: readonly string[];
    signal: AbortSignal;
    onBackgroundStart(): void;
    backgroundGraceMs?: number;
}): { voice: Promise<PromiseSettledResult<void>[]>; background: Promise<void> } {
    const { supervisor, signal } = options;
    const voice = Promise.allSettled(["stt", "tts"].map(name => supervisor.start(name, signal)));
    const background = (async (): Promise<void> => {
        const graceController = new AbortController();
        const grace = delay(options.backgroundGraceMs ?? 10_000, undefined, {
            signal: AbortSignal.any([signal, graceController.signal]),
        });
        try {
            await Promise.race([voice, grace]);
        } finally {
            graceController.abort();
        }
        signal.throwIfAborted();
        options.onBackgroundStart();
        await Promise.allSettled(options.backgroundServices.map(name => supervisor.start(name, signal)));
    })();
    return { voice, background };
}
