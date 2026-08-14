import { spawn } from "node:child_process";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ToolResult } from "../../shared/types.ts";
import { applicationResolver } from "../system/application-resolver.ts";
import type { ToolContext } from "../tools/tool.ts";
import { debugLog } from "../utils/debug.ts";
import { perf } from "../utils/performance.ts";

type IndexedPath = {
    path: string;
    name: string;
    normalizedName: string;
    type: "file" | "directory";
};

function normalize(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}

async function pathType(target: string): Promise<"file" | "directory" | null> {
    try {
        const details = await stat(target);
        return details.isDirectory() ? "directory" : details.isFile() ? "file" : null;
    } catch {
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
    private readonly index: IndexedPath[] = [];
    private indexPromise: Promise<void> | null = null;

    constructor() {
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

        this.searchRoots = [...new Set(candidates.map(value => path.resolve(value)))];
    }

    startIndexing(): void {
        if (!this.indexPromise) {
            this.indexPromise = perf.measure("Filesystem index", () => this.buildIndex());
        }
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
        const entries = await readdir(directory, { withFileTypes: true });
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
        this.index.push({ path: target, name: path.basename(target), normalizedName: normalize(path.basename(target)), type: "directory" });

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
        const requested = target && !/^(?:isso|isto|aqui|essa pasta|esta pasta)$/i.test(target.trim())
            ? await this.resolvePath(target, undefined, context)
            : this.lastPath || this.currentDirectory;
        const resolved = requested ?? this.currentDirectory;
        const match = await applicationResolver.resolve("Visual Studio Code", context.signal);

        if (!match) return { success: false, message: "Não encontrei o Visual Studio Code." };
        context.signal?.throwIfAborted();
        await spawnDetached(match.entry.command, [...match.entry.args, resolved]);
        this.lastPath = resolved;
        if (await pathType(resolved) === "directory") this.currentDirectory = resolved;
        return { success: true, message: `Abrindo ${resolved} no VS Code.`, speech: "Abrindo no VS Code.", data: { path: resolved } };
    }

    async openInExplorer(target?: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const resolved = target
            ? await this.resolvePath(target, undefined, context)
            : this.lastPath || this.currentDirectory;
        if (!resolved) return { success: false, message: `Não encontrei ${target}.` };
        context.signal?.throwIfAborted();
        const type = await pathType(resolved);
        await spawnDetached("explorer.exe", type === "file" ? ["/select,", resolved] : [resolved]);
        this.lastPath = resolved;
        return { success: true, message: `Abrindo ${resolved} no Explorer.`, speech: "Abrindo.", data: { path: resolved } };
    }

    async openProject(query: string, context: ToolContext = {}): Promise<ToolResult<{ path: string }>> {
        const found = await this.resolvePath(query.replace(/^(?:meu|minha)\s+(?:projeto|pasta)\s+/i, ""), "directory", context, true);
        if (!found) return { success: false, message: `Não encontrei o projeto ${query}.` };
        this.currentDirectory = found;
        this.lastPath = found;
        await spawnDetached("explorer.exe", [found]);
        return { success: true, message: `Abrindo ${found}.`, speech: "Abrindo.", data: { path: found } };
    }

    private async resolvePath(
        target: string,
        expected?: "file" | "directory",
        context: ToolContext = {},
        forceSearch = false,
    ): Promise<string | null> {
        context.signal?.throwIfAborted();
        const cleanTarget = target.trim().replace(/^['"]|['"]$/g, "");
        const normalized = normalize(cleanTarget);

        if (/^(?:isso|isto|aqui|essa pasta|esta pasta)$/.test(normalized)) {
            const contextual = this.lastPath || this.currentDirectory;
            const type = await pathType(contextual);
            return !expected || type === expected ? contextual : null;
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
                const type = await pathType(candidate);
                if (type && (!expected || type === expected)) return candidate;
            }
        }

        this.startIndexing();
        await this.indexPromise;
        context.signal?.throwIfAborted();
        const exact = this.index.find(entry => (
            entry.normalizedName === normalized
            && (!expected || entry.type === expected)
        ));
        if (exact) return exact.path;

        const partial = this.index.find(entry => (
            entry.normalizedName.includes(normalized)
            && (!expected || entry.type === expected)
        ));
        return partial?.path ?? null;
    }

    private async buildIndex(): Promise<void> {
        const pending = this.searchRoots.map(root => ({ root, directory: root, depth: 0 }));
        const seen = new Set<string>();

        while (pending.length > 0 && this.index.length < 50_000) {
            const current = pending.shift();
            if (!current || seen.has(current.directory)) continue;
            seen.add(current.directory);

            let entries;
            try {
                await access(current.directory);
                entries = await readdir(current.directory, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (/^(?:\.git|node_modules|\.venv|AppData)$/i.test(entry.name)) continue;
                const fullPath = path.join(current.directory, entry.name);
                const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
                if (!type) continue;
                this.index.push({ path: fullPath, name: entry.name, normalizedName: normalize(entry.name), type });

                if (entry.isDirectory() && current.depth < 7) {
                    pending.push({ root: current.root, directory: fullPath, depth: current.depth + 1 });
                }
            }
        }

        debugLog(`[FILESYSTEM] ${this.index.length} caminhos indexados.`);
    }
}

export const fileSystem = new FileSystemService();
