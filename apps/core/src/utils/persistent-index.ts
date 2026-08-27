import { createHash, randomUUID } from "node:crypto";
import type { Dir, Dirent } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export interface IndexEnvelope<T> {
    schemaVersion: 1;
    signature: string;
    updatedAt: number;
    payload: T;
}

export function indexSignature(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function pathKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isWithinRoots(target: string, roots: readonly string[]): boolean {
    return path.isAbsolute(target) && roots.some(root => {
        const relative = path.relative(pathKey(root), pathKey(target));
        return !relative || (!relative.startsWith(`..${path.sep}`)
            && relative !== ".." && !path.isAbsolute(relative));
    });
}

export async function readIndexCache(
    filePath: string | null,
    signature: string,
    signal?: AbortSignal,
): Promise<IndexEnvelope<unknown> | null> {
    if (!filePath) return null;
    signal?.throwIfAborted();
    try {
        const details = await waitForIndex(stat(filePath), signal);
        signal?.throwIfAborted();
        if (!details.isFile() || details.size > 32 * 1024 * 1024) return null;
        const value: unknown = JSON.parse(await readFile(filePath, { encoding: "utf8", signal }));
        signal?.throwIfAborted();
        if (!isRecord(value) || value.schemaVersion !== 1 || value.signature !== signature
            || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)
            || value.updatedAt < 0 || value.updatedAt > Date.now() + 60_000) return null;
        return value as unknown as IndexEnvelope<unknown>;
    } catch {
        signal?.throwIfAborted();
        // A missing, incompatible or corrupt cache is a cache miss, never a
        // reason to break the existing tools.
        return null;
    }
}

/** Complete, flushed temporary file + same-directory rename; never partial JSON. */
export async function writeIndexCache<T>(
    filePath: string | null,
    envelope: IndexEnvelope<T>,
    signal?: AbortSignal,
): Promise<void> {
    if (!filePath) return;
    signal?.throwIfAborted();
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
        signal?.throwIfAborted();
        const file = await open(temporaryPath, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify(envelope), { encoding: "utf8", signal });
            await file.sync();
        } finally {
            await file.close();
        }
        signal?.throwIfAborted();
        await rename(temporaryPath, filePath);
    } finally {
        // Only this operation's uniquely named temporary file can be removed.
        await unlink(temporaryPath).catch(() => undefined);
    }
}

export function waitForIndex<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T>;
export function waitForIndex<T>(promise: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T | undefined>;
export async function waitForIndex<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
    timeoutMs?: number,
): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    let abort: (() => void) | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<undefined>((resolve, reject) => {
                if (timeoutMs !== undefined) timer = setTimeout(() => resolve(undefined), timeoutMs);
                if (signal) {
                    abort = (): void => reject(signal.reason);
                    signal.addEventListener("abort", abort, { once: true });
                    if (signal.aborted) abort();
                }
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
    }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface DirectoryItem {
    name: string;
    type: "file" | "directory";
}

export interface DirectorySnapshot {
    directory: string;
    mtimeMs: number;
    entries: DirectoryItem[];
}

export function restoreDirectorySnapshots(
    value: unknown,
    roots: readonly string[],
): Map<string, DirectorySnapshot> {
    const snapshots = new Map<string, DirectorySnapshot>();
    if (!Array.isArray(value) || value.length > 10_000) return snapshots;
    let entries = 0;
    for (const candidate of value) {
        if (!isRecord(candidate) || typeof candidate.directory !== "string"
            || !isWithinRoots(candidate.directory, roots)
            || typeof candidate.mtimeMs !== "number" || !Number.isFinite(candidate.mtimeMs)
            || !Array.isArray(candidate.entries)) continue;
        const valid: DirectoryItem[] = [];
        for (const entry of candidate.entries) {
            if (++entries > 100_000) return new Map();
            if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name
                || entry.name === "." || entry.name === ".." || /[\\/\0]/.test(entry.name)
                || (entry.type !== "file" && entry.type !== "directory")) continue;
            valid.push({ name: entry.name, type: entry.type });
        }
        snapshots.set(pathKey(candidate.directory), {
            directory: candidate.directory,
            mtimeMs: candidate.mtimeMs,
            entries: valid,
        });
    }
    return snapshots;
}

export interface TreeScanOptions {
    roots: readonly { directory: string; maxDepth: number }[];
    snapshots: Map<string, DirectorySnapshot>;
    signal: AbortSignal;
    skipName: RegExp;
    maxEntries: number;
    maxDirectories?: number;
    maxDurationMs?: number;
    onEntry(entry: DirectoryItem, fullPath: string): void;
}

function trimSnapshots(snapshots: Map<string, DirectorySnapshot>): void {
    let items = 0;
    for (const snapshot of snapshots.values()) items += snapshot.entries.length;
    for (const [key, snapshot] of snapshots) {
        if (snapshots.size <= 10_000 && items <= 100_000) break;
        snapshots.delete(key);
        items -= snapshot.entries.length;
    }
}

class IndexScanDeadlineError extends Error {
    constructor() { super("Index scan deadline exceeded"); }
}

async function waitForScan<T>(promise: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
    const result = await waitForIndex(promise.then(value => ({ value })), signal,
        Math.max(0, deadline - performance.now()));
    signal.throwIfAborted();
    if (!result) throw new IndexScanDeadlineError();
    return result.value;
}

async function openDirectoryForScan(target: string, signal: AbortSignal, deadline: number): Promise<Dir> {
    const opening = opendir(target);
    try {
        return await waitForScan(opening, signal, deadline);
    } catch (error) {
        // opendir itself is not cancellable. A late handle still belongs to us,
        // even after the caller has stopped waiting for it.
        void opening.then(directory => directory.close()).catch(() => undefined);
        throw error;
    }
}

async function* directoryEntriesForScan(directory: Dir, signal: AbortSignal, deadline: number): AsyncGenerator<Dirent> {
    let reading: Promise<Dirent | null> | undefined;
    try {
        while (true) {
            signal.throwIfAborted();
            reading = directory.read();
            const entry = await waitForScan(reading, signal, deadline);
            reading = undefined;
            if (!entry) return;
            yield entry;
        }
    } finally {
        // Do not close concurrently with an outstanding read. Release promptly
        // on cancellation/deadline; close exactly once after that read settles.
        const closing = (reading ?? Promise.resolve()).catch(() => undefined).then(() => directory.close());
        void closing.catch(() => undefined);
        if (!reading && !signal.aborted && performance.now() < deadline) {
            await waitForScan(closing, signal, deadline);
        }
    }
}

/** Bounded BFS. Unchanged directories reuse cached listings, not recursive readdir. */
export async function scanDirectoryTree(options: TreeScanOptions) {
    trimSnapshots(options.snapshots);
    const pending = options.roots.map(root => ({ ...root, depth: 0 }));
    const seen = new Set<string>();
    const startedAt = performance.now();
    const deadline = startedAt + (options.maxDurationMs ?? 10_000);
    let visited = 0;
    let listed = 0;
    let reused = 0;
    let indexed = 0;
    let complete = true;
    let cursor = 0;
    while (cursor < pending.length) {
        options.signal.throwIfAborted();
        if (visited >= (options.maxDirectories ?? 5_000) || indexed >= options.maxEntries
            || performance.now() - startedAt >= (options.maxDurationMs ?? 10_000)) {
            complete = false;
            break;
        }
        const current = pending[cursor++];
        const key = pathKey(current.directory);
        if (seen.has(key)) continue;
        seen.add(key);
        visited += 1;
        if (visited % 24 === 0) await yieldToEventLoop(undefined, { signal: options.signal });
        let snapshot: DirectorySnapshot;
        try {
            let details = await waitForScan(lstat(current.directory), options.signal, deadline);
            options.signal.throwIfAborted();
            // Explicit roots may be user-configured junctions (e.g. redirected
            // Documents). Nested links are never followed outside the roots.
            if (details.isSymbolicLink() && current.depth === 0) {
                details = await waitForScan(stat(current.directory), options.signal, deadline);
            }
            if (details.isSymbolicLink() || !details.isDirectory()) continue;
            const previous = options.snapshots.get(key);
            if (previous?.mtimeMs === details.mtimeMs) {
                snapshot = previous;
                reused += 1;
            } else {
                const entries: DirectoryItem[] = [];
                const directory = await openDirectoryForScan(current.directory, options.signal, deadline);
                listed += 1;
                for await (const entry of directoryEntriesForScan(directory, options.signal, deadline)) {
                    options.signal.throwIfAborted();
                    if (performance.now() - startedAt >= (options.maxDurationMs ?? 10_000)) {
                        complete = false;
                        break;
                    }
                    if (options.skipName.test(entry.name) || entry.isSymbolicLink()) continue;
                    const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
                    if (type) entries.push({ name: entry.name, type });
                    if (entries.length > options.maxEntries - indexed) {
                        complete = false;
                        break;
                    }
                }
                snapshot = { directory: current.directory, mtimeMs: details.mtimeMs, entries };
                // A clipped listing must not be mistaken for a complete one on
                // a later refresh when the directory's mtime is unchanged.
                if (complete) options.snapshots.set(key, snapshot);
            }
        } catch (error) {
            options.signal.throwIfAborted();
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code !== "ENOENT" && code !== "ENOTDIR") complete = false;
            options.snapshots.delete(key);
            if (error instanceof IndexScanDeadlineError) break;
            continue;
        }
        for (const entry of snapshot.entries) {
            options.signal.throwIfAborted();
            if (options.skipName.test(entry.name)) continue;
            if (indexed >= options.maxEntries) { complete = false; break; }
            const fullPath = path.join(current.directory, entry.name);
            options.onEntry(entry, fullPath);
            indexed += 1;
            if (indexed % 256 === 0) await yieldToEventLoop(undefined, { signal: options.signal });
            if (entry.type === "directory" && current.depth < current.maxDepth) {
                pending.push({ directory: fullPath, maxDepth: current.maxDepth, depth: current.depth + 1 });
            }
        }
    }
    trimSnapshots(options.snapshots);
    return { complete, visitedDirectories: visited, listedDirectories: listed,
        reusedDirectories: reused, indexedEntries: indexed };
}
