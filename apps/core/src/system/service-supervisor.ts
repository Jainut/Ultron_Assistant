import { setTimeout as delay } from "node:timers/promises";

import { awaitServiceOperation, serviceError, timedServiceOperation } from "./service-lifecycle.ts";

export type ServiceState = "starting" | "ready" | "degraded" | "restarting" | "failed" | "stopped";

export interface ServicePolicy {
    maxRestarts?: number;
    startupTimeoutMs?: number;
    healthTimeoutMs?: number;
    healthIntervalMs?: number;
    stopTimeoutMs?: number;
    backoffMs?: number;
    maxBackoffMs?: number;
    /** Optional external-service recovery: health only, never start/stop/replay. */
    probeWhenFailed?: boolean;
}

export interface SupervisedService {
    name: string;
    start(signal: AbortSignal): Promise<void>;
    stop(signal?: AbortSignal): Promise<void> | void;
    health?(signal: AbortSignal): Promise<boolean> | boolean;
    onFailure?(listener: (error: Error) => void): () => void;
    policy?: ServicePolicy;
}

export interface ServiceSnapshot {
    name: string;
    state: ServiceState;
    attempts: number;
    restarts: number;
    updatedAt: number;
    readyAt?: number;
    lastFailure?: { phase: "startup" | "health" | "process" | "shutdown"; error: string; code?: string };
}

interface ManagedService {
    service: SupervisedService;
    policy: Required<ServicePolicy>;
    snapshot: ServiceSnapshot;
    controller: AbortController;
    activeAttempt: AbortController | null;
    operation: Promise<void> | null;
    pendingFailure: Error | null;
    stopping: Promise<void> | null;
    healthTimer: NodeJS.Timeout | null;
    unsubscribe?: () => void;
}

const defaults: Required<ServicePolicy> = {
    maxRestarts: 2, startupTimeoutMs: 180_000, healthTimeoutMs: 2_000,
    healthIntervalMs: 30_000, stopTimeoutMs: 5_000, backoffMs: 500, maxBackoffMs: 10_000,
    probeWhenFailed: false,
};

/** Supervises service lifecycle only. It never owns, retries or replays tools. */
export class ServiceSupervisor {
    private readonly services = new Map<string, ManagedService>();
    private readonly listeners = new Set<(snapshot: ServiceSnapshot) => void>();
    private shutDown = false;

    register(service: SupervisedService): void {
        if (this.shutDown) throw new Error("Supervisor encerrado.");
        if (!service.name.trim() || this.services.has(service.name)) throw new Error("Nome de serviço inválido ou duplicado.");
        const policy = { ...defaults, ...service.policy };
        for (const key of Object.keys(defaults) as Array<keyof ServicePolicy>) {
            if (key === "probeWhenFailed") continue;
            if (!Number.isFinite(policy[key]) || policy[key] < 0) policy[key] = defaults[key];
        }
        policy.probeWhenFailed = service.policy?.probeWhenFailed === true;
        policy.maxRestarts = Math.min(5, Math.floor(policy.maxRestarts));
        const entry: ManagedService = { service, policy,
            snapshot: { name: service.name, state: "stopped", attempts: 0, restarts: 0, updatedAt: Date.now() },
            controller: new AbortController(), activeAttempt: null, operation: null, pendingFailure: null,
            stopping: null, healthTimer: null };
        this.services.set(service.name, entry);
        entry.unsubscribe = service.onFailure?.(error => {
            if (this.shutDown || entry.controller.signal.aborted
                || entry.snapshot.state === "failed" || entry.snapshot.state === "stopped") return;
            this.failure(entry, error, "process");
            entry.pendingFailure = error;
            if (entry.operation) {
                entry.activeAttempt?.abort(error);
                return;
            }
            this.transition(entry, "degraded");
            this.runExclusive(entry, () => this.runStart(entry, true)).catch(() => undefined);
        });
    }

    onStateChange(listener: (snapshot: ServiceSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    snapshots(): ServiceSnapshot[] {
        return [...this.services.values()].map(entry => structuredClone(entry.snapshot));
    }

    snapshot(name: string): ServiceSnapshot {
        return structuredClone(this.require(name).snapshot);
    }

    start(name: string, signal?: AbortSignal): Promise<void> {
        if (this.shutDown) return Promise.reject(new DOMException("Supervisor encerrado.", "AbortError"));
        if (signal?.aborted) return Promise.reject(signal.reason);
        const entry = this.require(name);
        if (entry.operation) return signal
            ? awaitServiceOperation(entry.operation, signal) : entry.operation;
        if (entry.snapshot.state === "ready") return Promise.resolve();
        // Only an explicit start after stopped/failed resets the retry budget.
        entry.controller = new AbortController();
        entry.snapshot.attempts = 0;
        entry.snapshot.restarts = 0;
        entry.pendingFailure = null;
        delete entry.snapshot.lastFailure;
        const controller = entry.controller;
        const abort = (): void => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        return this.runExclusive(entry, async () => {
            try {
                await this.runStart(entry, false);
            } finally {
                signal?.removeEventListener("abort", abort);
                if (controller.signal.aborted) {
                    await this.stopService(entry).catch(() => undefined);
                    this.transition(entry, "stopped");
                }
            }
        });
    }

    async startAll(signal?: AbortSignal): Promise<ServiceSnapshot[]> {
        await Promise.allSettled([...this.services.keys()].map(name => this.start(name, signal)));
        return this.snapshots();
    }

    async checkNow(name: string): Promise<ServiceSnapshot> {
        const entry = this.require(name);
        if (entry.operation) {
            await entry.operation.catch(() => undefined);
            return this.snapshot(name);
        }
        if (entry.snapshot.state === "failed" && entry.policy.probeWhenFailed
            && entry.service.health && !entry.controller.signal.aborted && !this.shutDown) {
            await this.runExclusive(entry, async () => {
                try {
                    await this.checkHealth(entry);
                    entry.controller.signal.throwIfAborted();
                    entry.pendingFailure = null;
                    entry.snapshot.readyAt = Date.now();
                    this.transition(entry, "ready");
                } catch (error) {
                    if (!entry.controller.signal.aborted) this.failure(entry, error, "health");
                } finally {
                    this.scheduleHealth(entry);
                }
            });
            return this.snapshot(name);
        }
        if (entry.snapshot.state !== "ready" || !entry.service.health || this.shutDown) return this.snapshot(name);
        await this.runExclusive(entry, async () => {
            const attempt = new AbortController();
            entry.activeAttempt = attempt;
            const signal = AbortSignal.any([entry.controller.signal, attempt.signal]);
            try {
                await this.checkHealth(entry, signal);
                signal.throwIfAborted();
                this.scheduleHealth(entry);
            } catch (error) {
                if (entry.controller.signal.aborted) return;
                this.failure(entry, error, "health");
                this.transition(entry, "degraded");
                await this.runStart(entry, true);
            } finally {
                if (entry.activeAttempt === attempt) entry.activeAttempt = null;
            }
        }).catch(() => undefined);
        return this.snapshot(name);
    }

    async stop(name: string): Promise<void> {
        const entry = this.require(name);
        entry.controller.abort(new DOMException("Serviço encerrado.", "AbortError"));
        entry.activeAttempt?.abort(entry.controller.signal.reason);
        this.clearHealthTimer(entry);
        try {
            await this.stopService(entry);
        } catch (error) {
            this.failure(entry, error, "shutdown");
        } finally {
            // The lifecycle races abort even for providers ignoring their signal;
            // wait for its cleanup before an explicit later start can take ownership.
            await entry.operation?.catch(() => undefined);
            this.transition(entry, "stopped");
        }
    }

    async stopAll(): Promise<void> {
        this.shutDown = true;
        await Promise.all([...this.services.keys()].map(name => this.stop(name)));
        for (const entry of this.services.values()) entry.unsubscribe?.();
    }

    private require(name: string): ManagedService {
        const entry = this.services.get(name);
        if (!entry) throw new Error(`Serviço não registrado: ${name}`);
        return entry;
    }

    private runExclusive(entry: ManagedService, work: () => Promise<void>): Promise<void> {
        if (entry.operation) return entry.operation;
        const task = Promise.resolve().then(work);
        entry.operation = task;
        const clear = (): void => {
            if (entry.operation !== task) return;
            entry.operation = null;
            // An error can arrive immediately after the final ready check but
            // before the operation settles. Do not lose it in that small window.
            if (entry.pendingFailure && entry.snapshot.state === "ready"
                && !entry.controller.signal.aborted && !this.shutDown) {
                this.transition(entry, "degraded");
                this.runExclusive(entry, () => this.runStart(entry, true)).catch(() => undefined);
            } else if (entry.snapshot.state === "failed" && entry.policy.probeWhenFailed) {
                this.scheduleHealth(entry);
            }
        };
        void task.then(clear, clear);
        return task;
    }

    private async runStart(entry: ManagedService, restarting: boolean): Promise<void> {
        this.clearHealthTimer(entry);
        let retry = restarting;
        while (true) {
            entry.controller.signal.throwIfAborted();
            if (retry) {
                if (entry.snapshot.restarts >= entry.policy.maxRestarts) {
                    this.transition(entry, "failed");
                    await this.stopService(entry).catch(() => undefined);
                    throw new Error(`Limite de reinicializações atingido para ${entry.service.name}.`);
                }
                try {
                    await this.stopService(entry);
                } catch (error) {
                    this.failure(entry, error, "shutdown");
                    this.transition(entry, "failed");
                    throw error;
                }
                entry.controller.signal.throwIfAborted();
                entry.snapshot.restarts += 1;
                this.transition(entry, "restarting");
                await delay(Math.min(entry.policy.maxBackoffMs,
                    entry.policy.backoffMs * 2 ** (entry.snapshot.restarts - 1)), undefined,
                { signal: entry.controller.signal });
            } else this.transition(entry, "starting");
            entry.snapshot.attempts += 1;
            entry.pendingFailure = null;
            const attempt = new AbortController();
            entry.activeAttempt = attempt;
            const signal = AbortSignal.any([entry.controller.signal, attempt.signal]);
            try {
                await timedServiceOperation(signal => entry.service.start(signal), {
                    signal, timeoutMs: entry.policy.startupTimeoutMs, label: `${entry.service.name} startup`,
                });
                signal.throwIfAborted();
                await this.checkHealth(entry, signal);
                signal.throwIfAborted();
                entry.snapshot.readyAt = Date.now();
                this.transition(entry, "ready");
                this.scheduleHealth(entry);
                return;
            } catch (error) {
                entry.controller.signal.throwIfAborted();
                this.failure(entry, error, "startup");
                this.transition(entry, "degraded");
                retry = true;
            } finally {
                if (entry.activeAttempt === attempt) entry.activeAttempt = null;
            }
        }
    }

    private async checkHealth(entry: ManagedService, signal = entry.controller.signal): Promise<void> {
        if (!entry.service.health) return;
        const healthy = await timedServiceOperation(signal => entry.service.health!(signal), {
            signal, timeoutMs: entry.policy.healthTimeoutMs, label: `${entry.service.name} health`,
        });
        if (!healthy) throw new Error(`${entry.service.name} indisponível.`);
    }

    private stopService(entry: ManagedService): Promise<void> {
        if (entry.stopping) return entry.stopping;
        const task = timedServiceOperation(signal => entry.service.stop(signal), {
            timeoutMs: entry.policy.stopTimeoutMs, label: `${entry.service.name} stop`,
        });
        entry.stopping = task;
        const clear = (): void => { if (entry.stopping === task) entry.stopping = null; };
        void task.then(clear, clear);
        return task;
    }

    private scheduleHealth(entry: ManagedService): void {
        this.clearHealthTimer(entry);
        if (!entry.service.health || entry.policy.healthIntervalMs <= 0
            || (entry.snapshot.state !== "ready"
                && !(entry.snapshot.state === "failed" && entry.policy.probeWhenFailed))
            || entry.controller.signal.aborted || this.shutDown) return;
        entry.healthTimer = setTimeout(() => { void this.checkNow(entry.service.name); }, entry.policy.healthIntervalMs);
        entry.healthTimer.unref();
    }

    private clearHealthTimer(entry: ManagedService): void {
        if (entry.healthTimer) clearTimeout(entry.healthTimer);
        entry.healthTimer = null;
    }

    private failure(entry: ManagedService, error: unknown, phase: NonNullable<ServiceSnapshot["lastFailure"]>["phase"]): void {
        const normalized = serviceError(error);
        const code = "code" in normalized && typeof normalized.code === "string"
            && /^[A-Z0-9_]{1,64}$/.test(normalized.code) ? normalized.code : undefined;
        // Do not put transcript text, device names, paths or provider bodies in
        // snapshots intended for HUD/IPC diagnostics.
        const name = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(normalized.name) ? normalized.name : "Error";
        entry.snapshot.lastFailure = { phase, error: name,
            ...(code ? { code } : {}) };
    }

    private transition(entry: ManagedService, state: ServiceState): void {
        entry.snapshot.state = state;
        entry.snapshot.updatedAt = Date.now();
        for (const listener of this.listeners) {
            try { listener(structuredClone(entry.snapshot)); } catch { /* Observer isolation. */ }
        }
    }
}
