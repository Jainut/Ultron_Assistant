import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { applications } from "../../config/config.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";

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

async function exists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function walk(
    root: string,
    options: { extensions: Set<string>; maxDepth: number; maxEntries: number },
): Promise<string[]> {
    if (!await exists(root)) return [];

    const found: string[] = [];
    const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

    while (pending.length > 0 && found.length < options.maxEntries) {
        const current = pending.shift();
        if (!current) break;

        let entries;

        try {
            entries = await readdir(current.directory, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current.directory, entry.name);

            if (entry.isDirectory() && current.depth < options.maxDepth) {
                if (!/^(?:node_modules|windows kits|microsoft shared|common files)$/i.test(entry.name)) {
                    pending.push({ directory: fullPath, depth: current.depth + 1 });
                }
            } else if (entry.isFile() && options.extensions.has(path.extname(entry.name).toLowerCase())) {
                found.push(fullPath);
            }

            if (found.length >= options.maxEntries) break;
        }
    }

    return found;
}

export class ApplicationResolver {
    private readonly entries = new Map<string, ApplicationEntry>();
    private quickScan: Promise<void> | null = null;
    private deepScan: Promise<void> | null = null;

    constructor() {
        for (const [name, app] of Object.entries(applications)) {
            this.add({
                name,
                aliases: aliasesFor(name),
                command: app.command,
                args: app.args,
                source: "configured",
                executable: app.command.toLowerCase().endsWith(".exe") ? app.command : undefined,
            });
        }
    }

    start(): void {
        if (!this.quickScan) {
            this.quickScan = perf.measure("App index quick scan", async () => {
                await Promise.allSettled([
                    this.scanStartMenus(),
                    this.scanPath(),
                    this.scanRegistry(),
                    this.scanStoreApps(),
                ]);
            });
        }

        if (!this.deepScan) {
            this.deepScan = this.quickScan.then(() => {
                return perf.measure("App index background", () => this.scanProgramFiles());
            });
        }
    }

    async resolve(query: string, signal?: AbortSignal): Promise<ApplicationMatch | null> {
        signal?.throwIfAborted();
        const immediate = this.toMatch(this.rank(query));

        if (immediate && immediate.score >= 0.92) {
            return immediate;
        }

        this.start();

        await Promise.race([
            this.quickScan,
            new Promise<void>(resolve => setTimeout(resolve, 650)),
        ]);
        signal?.throwIfAborted();

        let matches = this.rank(query);

        if (!matches[0] || matches[0].score < 0.7) {
            const pathEntry = await this.resolveWithWhere(query);
            if (pathEntry) this.add(pathEntry);
            matches = this.rank(query);
        }

        return this.toMatch(matches);
    }

    private add(entry: ApplicationEntry): void {
        const identity = `${normalize(entry.name)}|${normalize(entry.executable ?? entry.args[0] ?? entry.command)}`;
        const existing = this.entries.get(identity);

        if (existing?.source === "configured") return;
        this.entries.set(identity, entry);
    }

    private rank(query: string): Array<{ entry: ApplicationEntry; score: number }> {
        const normalizedQuery = normalize(query).replace(/^(?:o|a|um|uma)\s+/, "").trim();

        return [...this.entries.values()]
            .map(entry => ({
                entry,
                score: Math.max(...entry.aliases.map(alias => similarity(normalizedQuery, alias))),
            }))
            .sort((left, right) => {
                const difference = right.score - left.score;
                if (Math.abs(difference) > 0.001) return difference;
                return Number(right.entry.source === "configured") - Number(left.entry.source === "configured");
            });
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

    private async scanStartMenus(): Promise<void> {
        const roots = [
            process.env.APPDATA && path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
            process.env.PROGRAMDATA && path.join(process.env.PROGRAMDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
        ].filter((value): value is string => Boolean(value));
        const shortcuts = (await Promise.all(roots.map(root => walk(root, {
            extensions: new Set([".lnk", ".url"]), maxDepth: 8, maxEntries: 3_000,
        })))).flat();

        for (const shortcut of shortcuts) {
            const name = path.basename(shortcut, path.extname(shortcut));
            if (/^(?:uninstall|desinstalar|help|readme)/i.test(name)) continue;
            this.add({
                name,
                aliases: aliasesFor(name),
                command: "explorer.exe",
                args: [shortcut],
                source: "start-menu",
            });
        }
    }

    private async scanPath(): Promise<void> {
        const directories = (process.env.PATH ?? "")
            .split(path.delimiter)
            .map(value => value.trim().replace(/^"|"$/g, ""))
            .filter(Boolean);

        for (const directory of directories) {
            let entries;
            try {
                entries = await readdir(directory, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (!entry.isFile() || !/\.(?:exe|cmd|bat)$/i.test(entry.name)) continue;
                const executable = path.join(directory, entry.name);
                const name = path.basename(entry.name, path.extname(entry.name));
                this.add({
                    name,
                    aliases: aliasesFor(name),
                    command: executable,
                    args: [],
                    source: "path",
                    executable: entry.name.toLowerCase().endsWith(".exe") ? executable : undefined,
                });
            }
        }
    }

    private async scanRegistry(): Promise<void> {
        const roots = [
            "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
            "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
        ];

        for (const root of roots) {
            try {
                const { stdout } = await execFileAsync("reg.exe", ["query", root, "/s"], {
                    windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
                });
                let currentName = "";

                for (const line of stdout.split(/\r?\n/)) {
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
                debugLog("[APP RESOLVER] Registry indisponível:", error);
            }
        }
    }

    private async scanStoreApps(): Promise<void> {
        try {
            const { stdout } = await execFileAsync("powershell.exe", [
                "-NoProfile", "-NonInteractive", "-Command",
                "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
            ], { windowsHide: true, timeout: 7_000, maxBuffer: 4 * 1024 * 1024 });
            const parsed = JSON.parse(stdout) as { Name: string; AppID: string } | Array<{ Name: string; AppID: string }>;

            for (const app of Array.isArray(parsed) ? parsed : [parsed]) {
                if (!app?.Name || !app.AppID) continue;
                this.add({
                    name: app.Name,
                    aliases: aliasesFor(app.Name),
                    command: "explorer.exe",
                    args: [`shell:AppsFolder\\${app.AppID}`],
                    source: "store",
                });
            }
        } catch (error) {
            debugLog("[APP RESOLVER] Apps da Microsoft Store indisponíveis:", error);
        }
    }

    private async scanProgramFiles(): Promise<void> {
        const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
            .filter((value): value is string => Boolean(value));
        const executables = (await Promise.all(roots.map(root => walk(root, {
            extensions: new Set([".exe"]),
            maxDepth: root === process.env.LOCALAPPDATA ? 3 : 4,
            maxEntries: 6_000,
        })))).flat();

        for (const executable of executables) {
            const name = path.basename(executable, ".exe");
            if (/^(?:unins|uninstall|setup|update|crash|helper|service|launcher|report)/i.test(name)) continue;
            this.add({
                name,
                aliases: aliasesFor(name),
                command: executable,
                args: [],
                source: "program-files",
                executable,
            });
        }
    }

    private async resolveWithWhere(query: string): Promise<ApplicationEntry | null> {
        const executableName = normalize(query).replace(/\s+/g, "");
        if (!executableName) return null;

        try {
            const { stdout } = await execFileAsync("where.exe", [executableName], {
                windowsHide: true, timeout: 1_000,
            });
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
            return null;
        }
    }
}

export const applicationResolver = new ApplicationResolver();
