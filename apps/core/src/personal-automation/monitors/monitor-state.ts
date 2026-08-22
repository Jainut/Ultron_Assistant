import { AtomicJsonStore } from "../../automation-engine/stores.ts";

export interface MonitorDedupeRecord {
    readonly id: string;
    readonly seen: readonly string[];
    readonly updatedAt: string;
}

export type MonitorStateStore = AtomicJsonStore<MonitorDedupeRecord>;

export function createMonitorStateStore(filePath: string): MonitorStateStore {
    return new AtomicJsonStore<MonitorDedupeRecord>(filePath);
}

export async function rememberSeen(
    store: MonitorStateStore,
    stateId: string,
    currentSeen: ReadonlySet<string>,
    seenKey: string,
    now: Date,
): Promise<Set<string>> {
    const next = new Set(currentSeen);
    next.add(seenKey);
    await store.put({
        id: stateId,
        seen: [...next],
        updatedAt: now.toISOString(),
    });
    return next;
}

export async function loadSeen(
    store: MonitorStateStore,
    stateId: string,
): Promise<Set<string>> {
    return new Set((await store.get(stateId))?.seen ?? []);
}
