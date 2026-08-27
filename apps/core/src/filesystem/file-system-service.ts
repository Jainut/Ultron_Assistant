import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import type { ToolResult } from "../../shared/types.ts";
import { applicationResolver } from "../system/application-resolver.ts";
import type { ToolContext } from "../tools/tool.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";
import { runtimeConfig } from "../config/runtime.ts";
import {
    indexSignature, isRecord, isWithinRoots, pathKey, readIndexCache,
    restoreDirectorySnapshots, scanDirectoryTree, waitForIndex, writeIndexCache,
    type DirectorySnapshot,
} from "../utils/persistent-index.ts";

type IndexedPath = {
    path: string;
    name: string;
    normalizedName: string;
    type: "file" | "directory";
};

export interface FileSystemServiceOptions {
    searchRoots?: readonly string[];
    currentDirectory?: string;
    cachePath?: string | null;
    refreshIntervalMs?: number;
    searchWaitMs?: number;
    maxEntries?: number;
    maxDirectories?: number;
    maxScanDurationMs?: number;
}

const skippedDirectories = /^(?:\.git|node_modules|\.venv|AppData)$/i;

function normalize(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}

async function pathType(target: string, signal?: AbortSignal): Promise<"file" | "directory" | null> {
    try {
        const details = await waitForIndex(stat(target), signal);
        signal?.throwIfAborted();
        return details.isDirectory() ? "directory" : details.isFile() ? "file" : null;
    } catch {
        signal?.throwIfAborted();
        return null;
    }
}

function spawnDetached(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        child.once("spawn", () => {
            child.unref();
            resolve();
        });
        child.once("error", reject);
    });
}

export class FileSystemService {
    private currentDirectory = process.cwd();
    private lastPath = this.currentDirectory;
    private readonly searchRoots: string[];
    private readonly index = new Map<string, IndexedPath>();
    private indexPromise: Promise<void> | null = null;
    private loadPromise: Promise<void> | null = null;
    private snapshots = new Map<string, DirectorySnapshot>();
    private readonly lifecycle = new AbortController();
    private refreshTimer: NodeJS.Timeout | null = null;
    private updatedAt = 0;
    private scanComplete = false;
    private readonly cachePath: string | null;
    private readonly signature: string;
    private readonly refreshIntervalMs: number;
    private readonly maxIndexEntries: number;
    private lastScan = { visitedDirectories: 0, listedDirectories: 0, reusedDirectories: 0 };

    constructor(private readonly options: FileSystemServiceOptions = {}) {
        const profile = process.env.USERPROFILE ?? process.cwd();
        const configured = (process.env.ULTRON_SEARCH_ROOTS ?? "")
            .split(";")
            .map(value => value.trim())
            .filter(Boolean);
        const candidates = [
            path.join(profile, "Desktop"),
            path.join(profile, "Documents"),
            path.join(profile, "Downloads"),
            path.join(profile, "Projects"),
            path.join(profile, "GitHub"),
            process.env.OneDrive,
            ...configured,
        ].filter((value): value is string => Boolean(value));

        this.searchRoots = [...new Map((options.searchRoots ?? candidates)
            .map(value => [pathKey(value), path.resolve(value)])).values()];
        this.currentDirectory = path.resolve(options.currentDirectory ?? process.cwd());
        this.lastPath = this.currentDirectory;
        this.cachePath = options.cachePath === undefined
            ? path.join(runtimeConfig.projectRoot, "data", "indexes", "filesystem-v1.json")
            : options.cachePath;
        this.refreshIntervalMs = Math.max(1_000, options.refreshIntervalMs ?? 15 * 60_000);
        this.maxIndexEntries = Math.min(50_000, Math.max(1, options.maxEntries ?? 50_000));
        this.signature = indexSignature({ roots: this.searchRoots.map(pathKey), depth: 7,
            skipped: skippedDirectories.source, maxEntries: options.maxEntries ?? 50_000,
            maxDirectories: options.maxDirectories ?? 5_000, maxDurationMs: options.maxScanDurationMs ?? 10_000 });
    }

    startIndexing(): void {
        if (this.lifecycle.signal.aborted) return;
        void this.refreshIndex().catch(error => {
            if (!this.lifecycle.signal.aborted) debugLog("[FILESYSTEM] Falha ao atualizar índice:", error);
        });
    }

    /** Cancels traversal/waits/timers; no process-global cwd or aliases change. */
    stop(): void {
        this.lifecycle.abort();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
    }

    getIndexStatus() {
        return { entries: this.index.size, updatedAt: this.updatedAt, complete: this.scanComplete,
            refreshing: this.indexPromise !== null, ...this.lastScan };
    }

    refreshIndex(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
        if (this.indexPromise) return waitForIndex(this.indexPromise, options.signal).then(() => undefined);
        const signal = options.signal
            ? AbortSignal.any([this.lifecycle.signal, options.signal]) : this.lifecycle.signal;
        const task = (async () => {
            signal.throwIfAborted();
            await this.loadIndex();
            signal.throwIfAborted();
            const ttl = this.scanComplete ? this.refreshIntervalMs : Math.min(30_000, this.refreshIntervalMs);
            if (!options.force && this.updatedAt > 0 && Date.now() - this.updatedAt < ttl) return;
            await perf.measure("Filesystem index", () => this.buildIndex(signal));
        })();
        this.indexPromise = task;
        const settled = (): void => {
            if (this.indexPromise !== task) return;
            this.indexPromise = null;
            if (!signal.aborted) this.scheduleRefresh();
        };
        void task.then(settled, settled);
        return task;
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.lifecycle.signal.aborted) return;
        const ttl = this.scanComplete ? this.refreshIntervalMs : Math.min(30_000, this.refreshIntervalMs);
        const delay = Math.max(1_000, this.updatedAt + ttl - Date.now());
        this.refreshTimer = setTimeout(() => this.startIndexing(), delay);
        this.refreshTimer.unref();
    }

    private loadIndex(): Promise<void> {
        this.loadPromise ??= (async () => {
            const cached = await readIndexCache(this.cachePath, this.signature, this.lifecycle.signal);
            if (!cached || !isRecord(cached.payload) || !Array.isArray(cached.payload.entries)
                || cached.payload.entries.length > this.maxIndexEntries) return;
            for (const value of cached.payload.entries) {
                if (!isRecord(value) || typeof value.path !== "string"
                    || !isWithinRoots(value.path, this.searchRoots)
                    || (value.type !== "file" && value.type !== "directory")) continue;
                const name = path.basename(value.path);
                this.upsertIndex({ path: value.path, name,
                    normalizedName: normalize(name), type: value.type });
            }
            this.snapshots = restoreDirectorySnapshots(cached.payload.snapshots, this.searchRoots);
            this.updatedAt = cached.updatedAt;
            this.scanComplete = cached.payload.complete === true;
        })();
        return this.loadPromise;
    }

    private upsertIndex(entry: IndexedPath): void {
        const key = pathKey(entry.path);
        if (!this.index.has(key) && this.index.size >= this.maxIndexEntries) {
            const oldest = this.index.keys().next().value;
            if (oldest !== undefined) this.index.delete(oldest);
        }
        this.index.set(key, entry);
    }

    getCurrentDirectory(): ToolResult<{ path: string }> {
        return {
            success: true,
            message: this.currentDirectory,
            speech: `A pasta atual é ${path.basename(this.currentDirectory)}.`,
            data: { path: this.currentDirectory },
        };
    }

    async listDirectory(target?: string, context: ToolContext = {}): Promise<ToolResult> {
        const directory = target
            ? await this.resolvePath(target, "directory", context)
            : this.currentDirectory;

        if (!directory) {
            return { success: false, message: `Não encontrei a pasta ${target}.` };
        }

        context.signal?.throwIfAborted();
        const entries = await waitForIndex(readdir(directory, { withFileTypes: true }), context.signal);
        context.signal?.throwIfAborted();
        const names = entries
            .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
            .slice(0, 120)
            .map(entry => `${entry.isDirectory() ? "[pasta]" : "[arquivo]"} ${entry.name}`);
        this.lastPath = directory;

        return {
            success: true,
            message: names.length > 0 ? names.join(", ") : "A pasta está vazia.",
            speech: names.length > 12
                ? `Encontrei ${entries.length} itens. Os primeiros são ${names.slice(0, 8).map(name => name.replace(/^\[[^\]]+\]\s*/, "")).join(", ")}.`
                : names.map(name => name.replace(/^\[[^\]]+\]\s*/, "")).join(", ") || "A pasta está vazia.",
            data: { path: directory, entries: names, total: entries.length },
        };
    }

    async changeDirectory(target: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const normalized = normalize(target);
        const directory = /^(?:volta|voltar|sobe|pasta anterior)$/.test(normalized)
            ? path.dirname(this.currentDirectory)
            : await this.resolvePath(target, "directory", context);

        if (!directory) {
            return { success: false, message: `Não encontrei a pasta ${target}.` };
        }

        this.currentDirectory = directory;
        this.lastPath = directory;
        debugLog("[FILESYSTEM] cwd=", directory);

        return {
            success: true,
            message: directory,
            speech: "Certo.",
            data: { path: directory },
        };
    }

    async createDirectory(name: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        context.signal?.throwIfAborted();
        const target = path.isAbsolute(name) ? path.resolve(name) : path.resolve(this.currentDirectory, name);
        await mkdir(target, { recursive: false });
        this.lastPath = target;
        this.upsertIndex({ path: target, name: path.basename(target), normalizedName: normalize(path.basename(target)), type: "directory" });
        this.snapshots.delete(pathKey(path.dirname(target)));
        this.updatedAt = 0;

        return {
            success: true,
            message: `Pasta criada em ${target}.`,
            speech: "Criada.",
            data: { path: target },
        };
    }

    async findDirectory(query: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const found = await this.resolvePath(query, "directory", context, true);
        if (!found) return { success: false, message: `Não encontrei a pasta ${query}.` };
        this.lastPath = found;
        return { success: true, message: found, speech: `Encontrei em ${found}.`, data: { path: found } };
    }

    async findFile(query: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const found = await this.resolvePath(query, "file", context, true);
        if (!found) return { success: false, message: `Não encontrei o arquivo ${query}.` };
        this.lastPath = found;
        return { success: true, message: found, speech: `Encontrei em ${found}.`, data: { path: found } };
    }

    async openDirectory(target?: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const directory = target
            ? await this.resolvePath(target, "directory", context)
            : this.lastPath || this.currentDirectory;
        if (!directory) return { success: false, message: `Não encontrei a pasta ${target}.` };
        context.signal?.throwIfAborted();
        await spawnDetached("explorer.exe", [directory]);
        this.currentDirectory = directory;
        this.lastPath = directory;
        return { success: true, message: `Abrindo ${directory}.`, speech: "Abrindo.", data: { path: directory } };
    }

    async openFile(target: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const file = await this.resolvePath(target, "file", context);
        if (!file) return { success: false, message: `Não encontrei o arquivo ${target}.` };
        context.signal?.throwIfAborted();
        await spawnDetached("explorer.exe", [file]);
        this.lastPath = file;
        return { success: true, message: `Abrindo ${file}.`, speech: "Abrindo.", data: { path: file } };
    }

    async openInEditor(target?: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const resolved = await this.resolvePath(
            target || this.lastPath || this.currentDirectory, undefined, context,
        );
        // A failed explicit lookup must not silently open a different project.
        if (!resolved) return { success: false, message: `Não encontrei ${target || "o caminho anterior"}.` };
        const match = await applicationResolver.resolve("Visual Studio Code", context.signal);

        if (!match) return { success: false, message: "Não encontrei o Visual Studio Code." };
        context.signal?.throwIfAborted();
        await spawnDetached(match.entry.command, [...match.entry.args, resolved]);
        this.lastPath = resolved;
        if (await pathType(resolved, context.signal) === "directory") this.currentDirectory = resolved;
        return { success: true, message: `Abrindo ${resolved} no VS Code.`, speech: "Abrindo no VS Code.", data: { path: resolved } };
    }

    async openInExplorer(target?: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const resolved = target
            ? await this.resolvePath(target, undefined, context)
            : this.lastPath || this.currentDirectory;
        if (!resolved) return { success: false, message: `Não encontrei ${target}.` };
        context.signal?.throwIfAborted();
        const type = await pathType(resolved, context.signal);
        await spawnDetached("explorer.exe", type === "file" ? ["/select,", resolved] : [resolved]);
        this.lastPath = resolved;
        return { success: true, message: `Abrindo ${resolved} no Explorer.`, speech: "Abrindo.", data: { path: resolved } };
    }

    async openProject(query: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const found = await this.resolvePath(query.replace(/^(?:meu|minha)\s+(?:projeto|pasta)\s+/i, ""), "directory", context, true);
        if (!found) return { success: false, message: `Não encontrei o projeto ${query}.` };
        this.currentDirectory = found;
        this.lastPath = found;
        context.signal?.throwIfAborted();
        await spawnDetached("explorer.exe", [found]);
        return { success: true, message: `Abrindo ${found}.`, speech: "Abrindo.", data: { path: found } };
    }

    private async resolvePath(
        target: string,
        expected?: "file" | "directory",
        context: ToolContext = {},
        forceSearch = false,
    ): Promise<string | null> {
        const signal = context.signal
            ? AbortSignal.any([context.signal, this.lifecycle.signal]) : this.lifecycle.signal;
        signal.throwIfAborted();
        const cleanTarget = target.trim().replace(/^['"]|['"]$/g, "");
        const normalized = normalize(cleanTarget);
        if (!normalized) return null;

        if (/^(?:isso|isto|aqui|essa pasta|esta pasta)$/.test(normalized)) {
            const contextual = this.lastPath || this.currentDirectory;
            const type = await pathType(contextual, signal);
            signal.throwIfAborted();
            return type && (!expected || type === expected) ? contextual : null;
        }

        const profile = process.env.USERPROFILE ?? "";
        const aliases: Record<string, string> = {
            documentos: path.join(profile, "Documents"),
            documento: path.join(profile, "Documents"),
            downloads: path.join(profile, "Downloads"),
            download: path.join(profile, "Downloads"),
            desktop: path.join(profile, "Desktop"),
            "area de trabalho": path.join(profile, "Desktop"),
            projetos: path.join(profile, "Projects"),
            github: path.join(profile, "GitHub"),
            onedrive: process.env.OneDrive ?? path.join(profile, "OneDrive"),
        };
        const directCandidates = [
            aliases[normalized],
            path.isAbsolute(cleanTarget) ? path.resolve(cleanTarget) : path.resolve(this.currentDirectory, cleanTarget),
            ...this.searchRoots.map(root => path.resolve(root, cleanTarget)),
        ].filter((value): value is string => Boolean(value));

        if (!forceSearch) {
            for (const candidate of directCandidates) {
                const type = await pathType(candidate, signal);
                signal.throwIfAborted();
                if (type && (!expected || type === expected)) return candidate;
            }
        }

        await waitForIndex(this.loadIndex(), signal);
        const cached = await this.findCachedPath(normalized, expected, signal);
        this.startIndexing();
        if (cached) return cached;
        if (this.indexPromise) {
            await waitForIndex(this.indexPromise, signal, this.options.searchWaitMs ?? 300);
        }
        return this.findCachedPath(normalized, expected, signal);
    }

    private async findCachedPath(
        query: string,
        expected: "file" | "directory" | undefined,
        signal: AbortSignal,
    ): Promise<string | null> {
        for (const exact of [true, false]) {
            let visited = 0;
            for (const [key, entry] of this.index) {
                signal.throwIfAborted();
                if (++visited % 512 === 0) await yieldToEventLoop(undefined, { signal });
                if ((expected && entry.type !== expected)
                    || (exact ? entry.normalizedName !== query : !entry.normalizedName.includes(query))) continue;
                const type = await pathType(entry.path, signal);
                signal.throwIfAborted();
                if (type === entry.type) return entry.path;
                this.index.delete(key);
                this.snapshots.delete(pathKey(path.dirname(entry.path)));
                this.updatedAt = 0;
            }
        }
        return null;
    }

    private async buildIndex(signal: AbortSignal): Promise<void> {
        const nextIndex = new Map<string, IndexedPath>();
        const result = await scanDirectoryTree({
            roots: this.searchRoots.map(directory => ({ directory, maxDepth: 7 })),
            snapshots: this.snapshots,
            signal,
            skipName: skippedDirectories,
            maxEntries: this.maxIndexEntries,
            maxDirectories: this.options.maxDirectories ?? 5_000,
            maxDurationMs: this.options.maxScanDurationMs ?? 10_000,
            onEntry: (entry, fullPath) => {
                const key = pathKey(fullPath);
                const indexed: IndexedPath = { path: fullPath, name: entry.name,
                    normalizedName: normalize(entry.name), type: entry.type };
                nextIndex.set(key, indexed);
                this.upsertIndex(indexed);
            },
        });
        signal.throwIfAborted();
        if (result.complete) {
            const contextual = [...this.index.values()].filter(entry => !isWithinRoots(entry.path, this.searchRoots));
            this.index.clear();
            for (const entry of contextual) this.upsertIndex(entry);
            for (const entry of nextIndex.values()) this.upsertIndex(entry);
        }
        this.scanComplete = result.complete;
        this.updatedAt = Date.now();
        this.lastScan = result;
        try {
            await writeIndexCache(this.cachePath, { schemaVersion: 1, signature: this.signature,
                updatedAt: this.updatedAt, payload: {
                    complete: this.scanComplete,
                    entries: [...this.index.values()].filter(entry => isWithinRoots(entry.path, this.searchRoots)),
                    snapshots: [...this.snapshots.values()],
                } }, signal);
        } catch (error) {
            signal.throwIfAborted();
            debugLog("[FILESYSTEM] Cache indisponível; índice em memória preservado:", error);
        }
        debugLog(`[FILESYSTEM] ${this.index.size} caminhos indexados.`, result);
    }
}

export const fileSystem = new FileSystemService();
