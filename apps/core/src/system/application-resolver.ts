import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { applications } from "../../config/config.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";
import { runtimeConfig } from "../config/runtime.ts";
import {
    indexSignature, isRecord, pathKey, readIndexCache, restoreDirectorySnapshots,
    scanDirectoryTree, waitForIndex, writeIndexCache, type DirectorySnapshot,
} from "../utils/persistent-index.ts";

const execFileAsync = promisify(execFile);

export interface ApplicationEntry {
    name: string;
    aliases: string[];
    command: string;
    args: string[];
    source: "configured" | "start-menu" | "path" | "registry" | "store" | "program-files";
    executable?: string;
}

export interface ApplicationMatch {
    entry: ApplicationEntry;
    score: number;
    alternatives: ApplicationEntry[];
}

type DiscoveredSource = Exclude<ApplicationEntry["source"], "configured">;
const discoverySources: DiscoveredSource[] = ["start-menu", "path", "registry", "store", "program-files"];
const skippedDirectories = /^(?:node_modules|\.git|\.venv|windows kits|microsoft shared|common files|cache|code cache|gpucache|temp)$/i;

export interface ApplicationResolverOptions {
    cachePath?: string | null;
    startMenuRoots?: readonly string[];
    pathDirectories?: readonly string[];
    programFilesRoots?: readonly string[];
    configuredApplications?: Record<string, { command: string; args: string[] }>;
    scanWindowsSources?: boolean;
    refreshIntervalMs?: number;
    programFilesRefreshIntervalMs?: number;
    searchWaitMs?: number;
    maxScanDurationMs?: number;
    maxDirectories?: number;
}

function normalize(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .toLowerCase()
        .trim();
}

function expandEnvironment(value: string): string {
    return value.replace(/%([^%]+)%/g, (match, name: string) => {
        return process.env[name] ?? process.env[name.toUpperCase()] ?? match;
    });
}

function levenshtein(left: string, right: string): number {
    if (!left) return right.length;
    if (!right) return left.length;

    const row = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        let previous = row[0];
        row[0] = leftIndex;

        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const current = row[rightIndex];
            row[rightIndex] = Math.min(
                row[rightIndex] + 1,
                row[rightIndex - 1] + 1,
                previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
            );
            previous = current;
        }
    }

    return row[right.length];
}

function similarity(query: string, candidate: string): number {
    if (query === candidate) return 1;
    if (candidate.startsWith(query)) return 0.94;
    if (candidate.includes(query)) return 0.9;
    if (query.includes(candidate) && candidate.length >= 3) return 0.86;

    const queryTokens = new Set(query.split(" "));
    const candidateTokens = new Set(candidate.split(" "));
    const overlap = [...queryTokens].filter(token => candidateTokens.has(token)).length;
    const tokenScore = overlap / Math.max(queryTokens.size, candidateTokens.size, 1);
    const editScore = 1 - levenshtein(query, candidate) / Math.max(query.length, candidate.length, 1);

    return Math.max(tokenScore * 0.9, editScore * 0.82);
}

function aliasesFor(name: string): string[] {
    const normalized = normalize(name);
    const aliases = new Set([normalized]);

    if (/visual studio code|\bcode\b|^(?:vscode|vs code)$/.test(normalized)) {
        aliases.add("vscode");
        aliases.add("vs code");
        aliases.add("code");
        aliases.add("visual studio code");
    }

    if (/zen browser/.test(normalized)) aliases.add("zen");
    if (/google chrome/.test(normalized)) aliases.add("chrome");
    if (/mozilla firefox/.test(normalized)) aliases.add("firefox");
    if (/windows terminal/.test(normalized)) aliases.add("terminal");
    if (/spotify/.test(normalized)) aliases.add("spotify");

    return [...aliases];
}

async function exists(filePath: string, signal?: AbortSignal): Promise<boolean> {
    try {
        await waitForIndex(access(filePath), signal);
        signal?.throwIfAborted();
        return true;
    } catch {
        signal?.throwIfAborted();
        return false;
    }
}

export class ApplicationResolver {
    private readonly entries = new Map<string, ApplicationEntry>();
    private quickScan: Promise<void> | null = null;
    private refreshPromise: Promise<void> | null = null;
    private loadPromise: Promise<void> | null = null;
    private readonly lifecycle = new AbortController();
    private refreshTimer: NodeJS.Timeout | null = null;
    private snapshots = new Map<string, DirectorySnapshot>();
    private readonly scanningSources = new Map<DiscoveredSource, Set<string>>();
    private readonly sourceUpdatedAt = new Map<DiscoveredSource, number>();
    private readonly completeSources = new Set<DiscoveredSource>();
    private readonly limitedSources = new Set<DiscoveredSource>();
    private configuredCount = 0;
    private readonly startMenuRoots: string[];
    private readonly pathDirectories: string[];
    private readonly programFilesRoots: Array<{ directory: string; maxDepth: number }>;
    private readonly cachePath: string | null;
    private readonly signature: string;
    private readonly scanWindowsSources: boolean;
    private lastScan = { visitedDirectories: 0, listedDirectories: 0, reusedDirectories: 0 };

    constructor(private readonly options: ApplicationResolverOptions = {}) {
        const unique = (roots: readonly string[]): string[] => [...new Map(
            roots.map(root => [pathKey(root), path.resolve(root)]),
        ).values()];
        this.startMenuRoots = unique(options.startMenuRoots ?? [
            process.env.APPDATA && path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
            process.env.PROGRAMDATA && path.join(process.env.PROGRAMDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
        ].filter((root): root is string => Boolean(root)));
        this.pathDirectories = unique(options.pathDirectories ?? (process.env.PATH ?? "")
            .split(path.delimiter).map(value => value.trim().replace(/^"|"$/g, "")).filter(Boolean));
        this.programFilesRoots = unique(options.programFilesRoots ?? [
            process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA,
        ].filter((root): root is string => Boolean(root))).map(directory => ({
            directory,
            maxDepth: process.env.LOCALAPPDATA && pathKey(directory) === pathKey(process.env.LOCALAPPDATA) ? 3 : 4,
        }));
        this.cachePath = options.cachePath === undefined
            ? path.join(runtimeConfig.projectRoot, "data", "indexes", "applications-v1.json") : options.cachePath;
        this.scanWindowsSources = options.scanWindowsSources ?? process.platform === "win32";
        this.signature = indexSignature({ startMenuRoots: this.startMenuRoots.map(pathKey),
            pathDirectories: this.pathDirectories.map(pathKey), programFilesRoots: this.programFilesRoots,
            windowsSources: this.scanWindowsSources, skipped: skippedDirectories.source,
            maxDirectories: options.maxDirectories ?? 5_000, maxDurationMs: options.maxScanDurationMs ?? 10_000,
            configured: options.configuredApplications ?? applications });
        for (const [name, app] of Object.entries(options.configuredApplications ?? applications)) {
            this.add({
                name,
                aliases: aliasesFor(name),
                command: app.command,
                args: app.args,
                source: "configured",
                executable: app.command.toLowerCase().endsWith(".exe") ? app.command : undefined,
            });
        }
        this.configuredCount = this.entries.size;
    }

    start(): void {
        if (this.lifecycle.signal.aborted) return;
        void this.refresh().catch(error => {
            if (!this.lifecycle.signal.aborted) debugLog("[APP RESOLVER] Falha ao atualizar índice:", error);
        });
    }

    stop(): void {
        this.lifecycle.abort();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
    }

    getIndexStatus() {
        return { entries: this.entries.size, refreshing: this.refreshPromise !== null,
            sources: Object.fromEntries(this.sourceUpdatedAt), ...this.lastScan };
    }

    refresh(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
        if (this.refreshPromise) return waitForIndex(this.refreshPromise, options.signal).then(() => undefined);
        const signal = options.signal
            ? AbortSignal.any([options.signal, this.lifecycle.signal]) : this.lifecycle.signal;
        const due = (source: DiscoveredSource): boolean => options.force === true
            || Date.now() - (this.sourceUpdatedAt.get(source) ?? 0) >= this.sourceTtl(source);
        let needsRefresh = false;
        // Publish this generation before loading the cache. resolve() may join
        // immediately, and must never wait on a prior resolved/rejected scan.
        const quickScan = (async () => {
            signal.throwIfAborted();
            await this.loadIndex();
            signal.throwIfAborted();
            const quickSources: Array<[DiscoveredSource, () => Promise<boolean>]> = [
                ["start-menu", () => this.scanStartMenus(signal)],
                ["path", () => this.scanPath(signal)],
                ["registry", () => this.scanRegistry(signal)],
                ["store", () => this.scanStoreApps(signal)],
            ];
            const pending = quickSources.filter(([source]) => due(source));
            if (pending.length === 0 && !due("program-files")) return;
            needsRefresh = true;
            this.lastScan = { visitedDirectories: 0, listedDirectories: 0, reusedDirectories: 0 };
            await perf.measure("App index quick scan", async () => {
                await Promise.all(pending.map(([source, scan]) => this.scanSource(source, scan, signal)));
            });
        })();
        this.quickScan = quickScan;
        const task = (async () => {
            await quickScan;
            if (!needsRefresh) return;
            if (due("program-files")) {
                await perf.measure("App index background", () => this.scanSource(
                    "program-files", () => this.scanProgramFiles(signal), signal,
                ));
            }
            signal.throwIfAborted();
            try {
                await writeIndexCache(this.cachePath, { schemaVersion: 1, signature: this.signature,
                    updatedAt: Date.now(), payload: {
                        entries: [...this.entries.values()].filter(entry => entry.source !== "configured").slice(0, 30_000),
                        sources: Object.fromEntries(this.sourceUpdatedAt),
                        completeSources: [...this.completeSources],
                        snapshots: [...this.snapshots.values()],
                    } }, signal);
            } catch (error) {
                signal.throwIfAborted();
                debugLog("[APP RESOLVER] Cache indisponível; índice em memória preservado:", error);
            }
        })();
        this.refreshPromise = task;
        const settled = (): void => {
            if (this.refreshPromise !== task) return;
            this.refreshPromise = null;
            if (!signal.aborted) this.scheduleRefresh();
        };
        void task.then(settled, settled);
        return task;
    }

    private sourceTtl(source: DiscoveredSource): number {
        if (!this.completeSources.has(source)) return 5 * 60_000;
        return Math.max(1_000, source === "program-files"
            ? this.options.programFilesRefreshIntervalMs ?? 24 * 60 * 60_000
            : this.options.refreshIntervalMs ?? 30 * 60_000);
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (this.lifecycle.signal.aborted) return;
        const delay = Math.max(1_000, Math.min(...discoverySources.map(source =>
            (this.sourceUpdatedAt.get(source) ?? 0) + this.sourceTtl(source) - Date.now())));
        this.refreshTimer = setTimeout(() => this.start(), delay);
        this.refreshTimer.unref();
    }

    private async scanSource(source: DiscoveredSource, scan: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
        const seen = new Set<string>();
        this.scanningSources.set(source, seen);
        this.limitedSources.delete(source);
        try {
            const traversed = await scan();
            const complete = traversed && !this.limitedSources.has(source);
            signal.throwIfAborted();
            if (complete) {
                for (const [key, entry] of this.entries) {
                    if (entry.source === source && !seen.has(key)) this.entries.delete(key);
                }
                this.completeSources.add(source);
            } else this.completeSources.delete(source);
            this.sourceUpdatedAt.set(source, Date.now());
        } finally {
            this.scanningSources.delete(source);
        }
    }

    private loadIndex(): Promise<void> {
        this.loadPromise ??= (async () => {
            const cached = await readIndexCache(this.cachePath, this.signature, this.lifecycle.signal);
            if (!cached || !isRecord(cached.payload) || !Array.isArray(cached.payload.entries)
                || cached.payload.entries.length > 30_000) return;
            for (const entry of cached.payload.entries) {
                if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length > 512
                    || typeof entry.command !== "string" || !entry.command || entry.command.length > 32_768
                    || !Array.isArray(entry.args) || entry.args.length > 64
                    || !entry.args.every(argument => typeof argument === "string" && argument.length < 32_768)
                    || !discoverySources.includes(entry.source as DiscoveredSource)
                    || !Array.isArray(entry.aliases) || !entry.aliases.length || entry.aliases.length > 64
                    || !entry.aliases.every(alias => typeof alias === "string" && alias.length <= 512)
                    || (entry.executable !== undefined && typeof entry.executable !== "string")) continue;
                this.add(entry as unknown as ApplicationEntry);
            }
            if (isRecord(cached.payload.sources)) {
                for (const source of discoverySources) {
                    const updatedAt = cached.payload.sources[source];
                    if (typeof updatedAt === "number" && Number.isFinite(updatedAt)
                        && updatedAt >= 0 && updatedAt <= Date.now() + 60_000) this.sourceUpdatedAt.set(source, updatedAt);
                }
            }
            if (Array.isArray(cached.payload.completeSources)) {
                for (const source of discoverySources) {
                    if (cached.payload.completeSources.includes(source)) this.completeSources.add(source);
                }
            }
            this.snapshots = restoreDirectorySnapshots(cached.payload.snapshots, [
                ...this.startMenuRoots, ...this.pathDirectories, ...this.programFilesRoots.map(root => root.directory),
            ]);
        })();
        return this.loadPromise;
    }

    async resolve(query: string, signal?: AbortSignal): Promise<ApplicationMatch | null> {
        signal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
        signal.throwIfAborted();
        // Configured aliases remain usable immediately, including bare PATH
        // commands and custom launch arguments; discovery never replaces them.
        const immediate = this.toMatch(await this.rank(query, signal, true));

        if (immediate && immediate.score >= 0.92) {
            return immediate;
        }

        await waitForIndex(this.loadIndex(), signal);
        const cached = await this.validMatch(await this.rank(query, signal), signal);
        this.start();
        if (cached && cached.score >= 0.92) return cached;
        if (this.refreshPromise) {
            await waitForIndex(this.quickScan ?? this.refreshPromise, signal, this.options.searchWaitMs ?? 650);
        }
        let matches = await this.rank(query, signal);

        if (!matches[0] || matches[0].score < 0.7) {
            const pathEntry = await this.resolveWithWhere(query, signal);
            if (pathEntry) this.add(pathEntry);
            matches = await this.rank(query, signal);
        }

        return this.validMatch(matches, signal);
    }

    private add(entry: ApplicationEntry): void {
        const identity = `${normalize(entry.name)}|${normalize(entry.executable ?? entry.args[0] ?? entry.command)}`;
        const existing = this.entries.get(identity);

        if (existing?.source === "configured") return;
        if (entry.source !== "configured" && !existing
            && this.entries.size - this.configuredCount >= 30_000) {
            this.limitedSources.add(entry.source);
            for (const [key, candidate] of this.entries) {
                if (candidate.source !== "configured") { this.entries.delete(key); break; }
            }
        }
        this.entries.set(identity, entry);
        if (entry.source !== "configured") this.scanningSources.get(entry.source)?.add(identity);
    }

    private async rank(query: string, signal: AbortSignal, configuredOnly = false): Promise<Array<{ entry: ApplicationEntry; score: number }>> {
        const normalizedQuery = normalize(query).replace(/^(?:o|a|um|uma)\s+/, "").trim();
        if (!normalizedQuery || normalizedQuery.length > 256) return [];
        const ranked: Array<{ entry: ApplicationEntry; score: number }> = [];
        let visited = 0;
        for (const entry of this.entries.values()) {
            if (configuredOnly && entry.source !== "configured") continue;
            signal.throwIfAborted();
            if (++visited % 128 === 0) await yieldToEventLoop(undefined, { signal });
            ranked.push({ entry, score: Math.max(...entry.aliases.map(alias => similarity(normalizedQuery, alias))) });
        }
        return ranked.sort((left, right) => {
                const difference = right.score - left.score;
                if (Math.abs(difference) > 0.001) return difference;
                return Number(right.entry.source === "configured") - Number(left.entry.source === "configured");
            });
    }

    private async validMatch(matches: Array<{ entry: ApplicationEntry; score: number }>, signal: AbortSignal): Promise<ApplicationMatch | null> {
        const valid: typeof matches = [];
        let inspected = 0;
        for (const match of matches) {
            signal.throwIfAborted();
            if (match.score < 0.64 || valid.length >= 4 || inspected++ >= 32) break;
            const entry = match.entry;
            const target = entry.executable ?? (path.isAbsolute(entry.command) ? entry.command
                : entry.source === "start-menu" ? entry.args[0] : undefined);
            if (entry.source !== "configured" && target && !await exists(target, signal)) {
                signal.throwIfAborted();
                for (const [key, value] of this.entries) if (value === entry) this.entries.delete(key);
                this.snapshots.delete(pathKey(path.dirname(target)));
                this.sourceUpdatedAt.delete(entry.source);
                continue;
            }
            signal.throwIfAborted();
            valid.push(match);
        }
        return this.toMatch(valid);
    }

    private toMatch(
        matches: Array<{ entry: ApplicationEntry; score: number }>,
    ): ApplicationMatch | null {
        const best = matches[0];
        if (!best || best.score < 0.64) return null;

        const alternatives = matches
            .slice(1)
            .filter(match => match.score >= Math.max(0.76, best.score - 0.04))
            .map(match => match.entry)
            .slice(0, 3);
        return { entry: best.entry, score: best.score, alternatives };
    }

    private async scanFiles(
        roots: Array<{ directory: string; maxDepth: number }>,
        signal: AbortSignal,
        maxEntries: number,
        extensions: RegExp,
        onFile: (filePath: string) => void,
    ): Promise<boolean> {
        const result = await scanDirectoryTree({ roots, snapshots: this.snapshots, signal,
            skipName: skippedDirectories, maxEntries,
            maxDirectories: this.options.maxDirectories ?? 5_000,
            maxDurationMs: this.options.maxScanDurationMs ?? 10_000,
            onEntry: (entry, fullPath) => {
                if (entry.type === "file" && extensions.test(entry.name)) onFile(fullPath);
            },
        });
        this.lastScan.visitedDirectories += result.visitedDirectories;
        this.lastScan.listedDirectories += result.listedDirectories;
        this.lastScan.reusedDirectories += result.reusedDirectories;
        return result.complete;
    }

    private async scanStartMenus(signal: AbortSignal): Promise<boolean> {
        return this.scanFiles(this.startMenuRoots.map(directory => ({ directory, maxDepth: 8 })),
            signal, 15_000, /\.(?:lnk|url)$/i, shortcut => {
            const name = path.basename(shortcut, path.extname(shortcut));
            if (/^(?:uninstall|desinstalar|help|readme)/i.test(name)) return;
            this.add({
                name,
                aliases: aliasesFor(name),
                command: "explorer.exe",
                args: [shortcut],
                source: "start-menu",
            });
        });
    }

    private async scanPath(signal: AbortSignal): Promise<boolean> {
        return this.scanFiles(this.pathDirectories.map(directory => ({ directory, maxDepth: 0 })),
            signal, 30_000, /\.(?:exe|cmd|bat)$/i, executable => {
                const name = path.basename(executable, path.extname(executable));
                this.add({
                    name,
                    aliases: aliasesFor(name),
                    command: executable,
                    args: [],
                    source: "path",
                    executable: executable.toLowerCase().endsWith(".exe") ? executable : undefined,
                });
        });
    }

    private async scanRegistry(signal: AbortSignal): Promise<boolean> {
        if (!this.scanWindowsSources) return true;
        let complete = true;
        const roots = [
            "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
            "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        ];

        for (const root of roots) {
            try {
                const { stdout } = await execFileAsync("reg.exe", ["query", root, "/s"], {
                    windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024, signal,
                });
                let currentName = "";

                for (const line of stdout.split(/\r?\n/)) {
                    signal.throwIfAborted();
                    const key = line.trim().match(/\\([^\\]+\.exe)$/i)?.[1];
                    if (key) {
                        currentName = path.basename(key, ".exe");
                        continue;
                    }

                    const value = line.match(
                        /^\s+\((?:Default|padr[aã]o)\)\s+REG_\w+\s+(.+?\.exe)"?\s*$/i,
                    )?.[1];
                    if (!value || !currentName) continue;
                    const executable = expandEnvironment(value.trim().replace(/^"|"$/g, ""));
                    this.add({
                        name: currentName,
                        aliases: aliasesFor(currentName),
                        command: executable,
                        args: [],
                        source: "registry",
                        executable,
                    });
                }
            } catch (error) {
                signal.throwIfAborted();
                complete = false;
                debugLog("[APP RESOLVER] Registry indisponível:", error);
            }
        }
        return complete;
    }

    private async scanStoreApps(signal: AbortSignal): Promise<boolean> {
        if (!this.scanWindowsSources) return true;
        try {
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile", "-NonInteractive", "-Command",
                "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
            ], { windowsHide: true, timeout: 7_000, maxBuffer: 4 * 1024 * 1024, signal });
            const parsed = JSON.parse(stdout) as { Name: string; AppID: string } | Array<{ Name: string; AppID: string }>;

            for (const app of Array.isArray(parsed) ? parsed : [parsed]) {
                signal.throwIfAborted();
                if (!app?.Name || !app.AppID) continue;
                this.add({
                    name: app.Name,
                    aliases: aliasesFor(app.Name),
                    command: "explorer.exe",
                    args: [`shell:AppsFolder\\${app.AppID}`],
                    source: "store",
                });
            }
            return true;
        } catch (error) {
            signal.throwIfAborted();
            debugLog("[APP RESOLVER] Apps da Microsoft Store indisponíveis:", error);
            return false;
        }
    }

    private async scanProgramFiles(signal: AbortSignal): Promise<boolean> {
        return this.scanFiles(this.programFilesRoots, signal, 50_000, /\.exe$/i, executable => {
            const name = path.basename(executable, ".exe");
            if (/^(?:unins|uninstall|setup|update|crash|helper|service|launcher|report)/i.test(name)) return;
            this.add({
                name,
                aliases: aliasesFor(name),
                command: executable,
                args: [],
                source: "program-files",
                executable,
            });
        });
    }

    private async resolveWithWhere(query: string, signal: AbortSignal): Promise<ApplicationEntry | null> {
        if (!this.scanWindowsSources) return null;
        const executableName = normalize(query).replace(/\s+/g, "");
        if (!executableName || executableName.length > 256) return null;

        try {
            const { stdout } = await execFileAsync("where.exe", [executableName], {
                windowsHide: true, timeout: 1_000, signal,
            });
            signal.throwIfAborted();
            const executable = stdout.split(/\r?\n/).find(Boolean)?.trim();
            if (!executable) return null;
            return {
                name: path.basename(executable, path.extname(executable)),
                aliases: aliasesFor(query),
                command: executable,
                args: [],
                source: "path",
                executable,
            };
        } catch {
            signal.throwIfAborted();
            return null;
        }
    }
}

export const applicationResolver = new ApplicationResolver();
