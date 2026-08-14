import { performance } from "node:perf_hooks";
import { debugEnabled } from "./debug.ts";

class PerformanceTracker {
    private requestStart = 0;
    private timers = new Map<string, number>();

    startRequest() {
        this.requestStart = performance.now();

        if (debugEnabled) {
            console.log("\n[PERF] ────── ULTRON REQUEST ──────");
        }
    }

    start(name: string) {
        this.timers.set(name, performance.now());
    }

    end(name: string) {
        const start = this.timers.get(name);

        if (start === undefined) {
            if (debugEnabled) {
                console.warn(`[PERF] "${name}" não foi iniciado.`);
            }
            return 0;
        }

        const elapsed = performance.now() - start;

        if (debugEnabled) {
            console.log(
                `[PERF] ${name.padEnd(20, ".")} ${elapsed.toFixed(0)}ms`
            );
        }

        this.timers.delete(name);

        return elapsed;
    }

    markVoiceStart() {
        if (!this.requestStart) return;

        const elapsed = performance.now() - this.requestStart;

        if (debugEnabled) {
            console.log(
                `[PERF] ${"Time to voice".padEnd(20, ".")} ${elapsed.toFixed(0)}ms`
            );
        }
    }

    endRequest() {
        if (!this.requestStart) return;

        const elapsed = performance.now() - this.requestStart;

        if (debugEnabled) {
            console.log(
                `[PERF] ${"TOTAL".padEnd(20, ".")} ${elapsed.toFixed(0)}ms`
            );

            console.log("[PERF] ─────────────────────────────\n");
        }

        this.requestStart = 0;
        this.timers.clear();
    }
}

export const perf = new PerformanceTracker();
