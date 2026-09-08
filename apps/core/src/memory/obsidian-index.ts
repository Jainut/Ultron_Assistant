import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { awaitServiceOperation } from "../system/service-lifecycle.ts";
import {
    indexSignature,
    isRecord,
    isWithinRoots,
    pathKey,
    readIndexCache,
    restoreDirectorySnapshots,
    scanDirectoryTree,
    waitForIndex,
    writeIndexCache,
    type DirectorySnapshot,
} from "../utils/persistent-index.ts";
import { normalizeNoteText, parseMarkdownNote, type MarkdownNote } from "./markdown-note.ts";

interface NoteRecord {
    id: string;
    mtimeMs: number;
    ctimeMs: number;
    size: number;
    markdown: string;
    note: MarkdownNote;
}
export interface NoteSummary {
    id: string;
    title: string;
    tags: string[];
    excerpt: string;
}
export interface ObsidianIndexStatus {
    configured: boolean;
    state: "disabled" | "loading" | "ready" | "partial" | "unavailable" | "stopped";
    notes: number;
    updatedAt: number | null;
    readFiles: number;
    reusedFiles: number;
    skippedFiles: number;
    durationMs: number;
}

export class ObsidianError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "ObsidianError";
    }
}

/** Opt-in local index. All writes go to its derived cache, never to the vault. */
export class ObsidianIndex {
    private readonly lifetime = new AbortController();
    private records = new Map<string, NoteRecord>();
    private readonly paths = new Map<string, Set<string>>();
    private readonly names = new Map<string, Set<string>>();
    private directories = new Map<string, DirectorySnapshot>();
    private root: string | null = null;
    private signature = "";
    private prepared = false;
    private inFlight: Promise<void> | null = null;
    private timer: NodeJS.Timeout | null = null;
    private lastAttemptAt = 0;
    private readonly state: ObsidianIndexStatus;

    constructor(
        private readonly options: {
            vaultPath?: string;
            cachePath?: string | null;
            refreshIntervalMs?: number;
            maxNotes?: number;
        } = {},
    ) {
        this.state = {
            configured: Boolean(options.vaultPath?.trim()),
            state: options.vaultPath?.trim() ? "loading" : "disabled",
            notes: 0,
            updatedAt: null,
            readFiles: 0,
            reusedFiles: 0,
            skippedFiles: 0,
            durationMs: 0,
        };
    }

    status(): ObsidianIndexStatus {
        return { ...this.state };
    }

    start(): void {
        if (!this.state.configured || this.lifetime.signal.aborted || this.timer) return;
        void this.refresh().catch(() => undefined);
        this.timer = setInterval(
            () => {
                void this.refresh().catch(() => undefined);
            },
            Math.max(30_000, this.options.refreshIntervalMs ?? 120_000),
        );
        this.timer.unref();
    }

    stop(): void {
        this.lifetime.abort(new DOMException("Índice encerrado", "AbortError"));
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.state.state = "stopped";
    }

    async refresh(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        this.assertEnabled();
        if (!this.inFlight) {
            const work = this.refreshIndex();
            this.inFlight = work;
            void work
                .finally(() => {
                    if (this.inFlight === work) this.inFlight = null;
                })
                .catch(() => undefined);
        }
        return signal ? awaitServiceOperation(this.inFlight, signal) : this.inFlight;
    }

    async search(
        query: string,
        limit = 5,
        signal?: AbortSignal,
    ): Promise<{ items: NoteSummary[]; index: ObsidianIndexStatus }> {
        signal = this.querySignal(signal);
        await this.ensureIndex(signal);
        const terms = normalizeNoteText(query).split(/\s+/).filter(Boolean).slice(0, 16);
        if (!terms.length || query.length > 512)
            throw new ObsidianError(
                "NOTE_QUERY_INVALID",
                "Informe uma busca de até 512 caracteres.",
            );
        const ranked: Array<{ record: NoteRecord; score: number }> = [];
        let visited = 0;
        for (const record of this.records.values()) {
            signal?.throwIfAborted();
            if (++visited % 100 === 0) await yieldLoop(undefined, { signal });
            const title = normalizeNoteText(
                `${record.note.title} ${record.note.aliases.join(" ")} ${record.id}`,
            );
            const body = normalizeNoteText(
                `${record.note.text} ${JSON.stringify(record.note.properties)}`,
            );
            let score = 0;
            for (const term of terms) {
                const tag = term.replace(/^(?:tag:)?#?/, "");
                if (term.startsWith("#") || term.startsWith("tag:")) {
                    if (
                        !record.note.tags.some(
                            (item) =>
                                normalizeNoteText(item) === tag ||
                                normalizeNoteText(item).startsWith(`${tag}/`),
                        )
                    ) {
                        score = 0;
                        break;
                    }
                    score += 8;
                } else if (title.includes(term)) score += 10;
                else if (body.includes(term)) score += 1;
                else {
                    score = 0;
                    break;
                }
            }
            if (score) ranked.push({ record, score });
        }
        ranked.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
        const items: NoteSummary[] = [];
        for (const { record } of ranked) {
            if (items.length >= Math.max(1, Math.min(20, Math.trunc(limit) || 5))) break;
            if (await this.currentMetadata(record, signal)) items.push(this.summary(record));
        }
        return { items, index: this.status() };
    }

    async read(reference: string, signal?: AbortSignal): Promise<MarkdownNote> {
        signal = this.querySignal(signal);
        await this.ensureIndex(signal);
        const record = this.resolve(reference);
        // Re-read the selected note: cached content is never authoritative for read().
        const fresh = await this.readRecord(record.id, signal);
        signal?.throwIfAborted();
        return structuredClone(fresh.note);
    }

    async connections(
        reference: string,
        signal?: AbortSignal,
    ): Promise<{
        note: NoteSummary;
        links: NoteSummary[];
        backlinks: NoteSummary[];
        unresolved: string[];
        index: ObsidianIndexStatus;
    }> {
        signal = this.querySignal(signal);
        await this.ensureIndex(signal);
        const record = this.resolve(reference);
        const fresh = await this.readRecord(record.id, signal);
        const targets = new Map<string, NoteSummary>();
        const unresolved: string[] = [];
        for (const target of fresh.note.links) {
            const resolved = this.resolveLink(target, record.id);
            if (resolved && (await this.currentMetadata(resolved, signal)))
                targets.set(resolved.id, this.summary(resolved));
            else unresolved.push(target);
            if (targets.size >= 50) break;
        }
        const backlinks: NoteSummary[] = [];
        let visited = 0;
        for (const candidate of this.records.values()) {
            signal?.throwIfAborted();
            if (++visited % 100 === 0) await yieldLoop(undefined, { signal });
            if (
                candidate.id !== record.id &&
                candidate.note.links.some(
                    (link) => this.resolveLink(link, candidate.id)?.id === record.id,
                ) &&
                (await this.currentMetadata(candidate, signal))
            )
                backlinks.push(this.summary(candidate));
            if (backlinks.length >= 50) break;
        }
        return {
            note: this.summary(fresh),
            links: [...targets.values()],
            backlinks,
            unresolved: unresolved.slice(0, 50),
            index: this.status(),
        };
    }

    private assertEnabled(): void {
        this.lifetime.signal.throwIfAborted();
        if (!this.state.configured)
            throw new ObsidianError(
                "VAULT_NOT_CONFIGURED",
                "Informe ULTRON_OBSIDIAN_VAULT para consultar suas notas.",
            );
    }

    private querySignal(signal?: AbortSignal): AbortSignal {
        // One budget for the entire query, not 2s for every stale candidate.
        return AbortSignal.any([
            this.lifetime.signal,
            ...(signal ? [signal] : []),
            AbortSignal.timeout(5000),
        ]);
    }

    private async ensureIndex(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        this.assertEnabled();
        if (Date.now() - this.lastAttemptAt > 30_000) void this.refresh().catch(() => undefined);
        if (!this.prepared && this.inFlight)
            await waitForIndex(
                this.inFlight.catch(() => undefined),
                signal,
                500,
            );
        if (!this.records.size && this.inFlight)
            await waitForIndex(
                this.inFlight.catch(() => undefined),
                signal,
                500,
            );
        signal?.throwIfAborted();
        if (this.state.state === "unavailable")
            throw new ObsidianError(
                "VAULT_UNAVAILABLE",
                "O vault não está disponível para leitura.",
            );
        if (!this.prepared || (!this.records.size && this.inFlight))
            throw new ObsidianError(
                "INDEX_LOADING",
                "Ainda estou indexando as notas. Tente novamente em instantes.",
            );
    }

    private async refreshIndex(): Promise<void> {
        this.lastAttemptAt = Date.now();
        const started = performance.now();
        const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(12_000)]);
        try {
            if (!this.root) {
                const configured = this.options.vaultPath!.trim();
                if (!path.isAbsolute(configured)) throw new Error("Vault must be absolute");
                const root = await waitForIndex(realpath(configured), signal);
                if (!(await waitForIndex(lstat(root), signal)).isDirectory())
                    throw new Error("Vault is not a directory");
                if (this.options.cachePath) {
                    const cache = path.resolve(this.options.cachePath);
                    if (isWithinRoots(cache, [root]))
                        throw new Error("Cache must stay outside the vault");
                    // Resolve the nearest existing parent too, so a junction to
                    // the vault cannot turn the derived cache into a vault write.
                    let parent = path.dirname(cache);
                    while (true) {
                        try {
                            const canonical = await waitForIndex(realpath(parent), signal);
                            if (isWithinRoots(canonical, [root]))
                                throw new ObsidianError(
                                    "CACHE_IN_VAULT",
                                    "O cache precisa ficar fora do vault.",
                                );
                            break;
                        } catch (error) {
                            signal.throwIfAborted();
                            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                            const next = path.dirname(parent);
                            if (next === parent) throw error;
                            parent = next;
                        }
                    }
                }
                this.root = root;
                this.signature = indexSignature({
                    type: "obsidian-read-only-v1",
                    root: pathKey(this.root),
                });
            }
            if (!this.prepared) {
                const cache = await readIndexCache(
                    this.options.cachePath ?? null,
                    this.signature,
                    signal,
                );
                if (cache && isRecord(cache.payload) && Array.isArray(cache.payload.notes)) {
                    let bytes = 0;
                    for (const candidate of cache.payload.notes.slice(0, this.maxNotes())) {
                        if (
                            !isRecord(candidate) ||
                            typeof candidate.id !== "string" ||
                            !this.validId(candidate.id) ||
                            typeof candidate.markdown !== "string" ||
                            candidate.markdown.length > 262_144 ||
                            ![candidate.mtimeMs, candidate.ctimeMs, candidate.size].every(
                                (value) =>
                                    typeof value === "number" &&
                                    Number.isFinite(value) &&
                                    value >= 0,
                            )
                        )
                            continue;
                        bytes += Buffer.byteLength(candidate.markdown, "utf8");
                        if (bytes > 16 * 1024 * 1024) break;
                        const saved = candidate as unknown as Omit<NoteRecord, "note">;
                        this.records.set(saved.id, {
                            ...saved,
                            note: parseMarkdownNote(saved.id, saved.markdown),
                        });
                        if (this.records.size % 64 === 0) await yieldLoop(undefined, { signal });
                    }
                    this.directories = restoreDirectorySnapshots(cache.payload.directories, [
                        this.root,
                    ]);
                    this.state.updatedAt = cache.updatedAt;
                }
                this.prepared = true;
                this.state.notes = this.records.size;
                this.rebuildReferences();
            }
            const candidates: string[] = [];
            let depthLimited = false;
            const scan = await scanDirectoryTree({
                roots: [{ directory: this.root, maxDepth: 16 }],
                snapshots: this.directories,
                signal,
                skipName: /^(?:\..*|node_modules|dist|build)$/i,
                maxEntries: 50_000,
                maxDurationMs: 6_000,
                onEntry: (entry, fullPath) => {
                    const relative = path.relative(this.root!, fullPath).replace(/\\/g, "/");
                    if (entry.type === "directory" && relative.split("/").length > 16)
                        depthLimited = true;
                    if (entry.type === "file" && /\.md$/i.test(entry.name))
                        candidates.push(relative);
                },
            });
            const next = new Map<string, NoteRecord>();
            let readFiles = 0,
                reusedFiles = 0,
                skippedFiles = 0,
                bytes = 0;
            for (const id of candidates.slice(0, this.maxNotes())) {
                signal.throwIfAborted();
                try {
                    const previous = this.records.get(id);
                    const file = await this.checkedPath(id, signal);
                    const same =
                        previous &&
                        previous.mtimeMs === file.details.mtimeMs &&
                        previous.ctimeMs === file.details.ctimeMs &&
                        previous.size === file.details.size;
                    const record = same ? previous : await this.readRecord(id, signal);
                    bytes += record.size;
                    if (bytes > 16 * 1024 * 1024) break;
                    next.set(id, record);
                    if (same) ++reusedFiles;
                    else ++readFiles;
                } catch {
                    signal.throwIfAborted();
                    ++skippedFiles;
                }
                if (next.size % 32 === 0) await yieldLoop(undefined, { signal });
            }
            signal.throwIfAborted();
            this.records = next;
            this.rebuildReferences();
            Object.assign(this.state, {
                state:
                    scan.complete &&
                    !depthLimited &&
                    !skippedFiles &&
                    candidates.length <= this.maxNotes() &&
                    bytes <= 16 * 1024 * 1024
                        ? "ready"
                        : "partial",
                notes: next.size,
                updatedAt: Date.now(),
                readFiles,
                reusedFiles,
                skippedFiles,
                durationMs: Math.round(performance.now() - started),
            });
            await writeIndexCache(
                this.options.cachePath ?? null,
                {
                    schemaVersion: 1,
                    signature: this.signature,
                    updatedAt: this.state.updatedAt!,
                    payload: {
                        notes: [...next.values()].map(({ note: _note, ...record }) => record),
                        directories: [...this.directories.values()],
                    },
                },
                signal,
            );
        } catch (error) {
            if (this.lifetime.signal.aborted) throw error;
            this.state.state = this.records.size ? "partial" : "unavailable";
            throw new ObsidianError(
                "VAULT_UNAVAILABLE",
                "Não consegui atualizar o índice de notas.",
            );
        }
    }

    private maxNotes(): number {
        return Math.max(1, Math.min(5000, Math.trunc(this.options.maxNotes ?? 5000) || 5000));
    }
    private validId(id: string): boolean {
        return (
            id.length <= 1024 &&
            /\.md$/i.test(id) &&
            !/[\\:\u0000-\u001f\u007f-\u009f]/.test(id) &&
            !id.split("/").some((part) => !part || part.startsWith(".")) &&
            !path.isAbsolute(id)
        );
    }
    private async checkedPath(id: string, signal?: AbortSignal) {
        if (!this.root || !this.validId(id))
            throw new ObsidianError(
                "NOTE_PATH_INVALID",
                "A nota precisa estar dentro do vault configurado.",
            );
        const target = path.join(this.root, id);
        const linked = AbortSignal.any([
            this.lifetime.signal,
            ...(signal ? [signal] : []),
            AbortSignal.timeout(2000),
        ]);
        let current = this.root;
        for (const part of id.split("/")) {
            current = path.join(current, part);
            if ((await waitForIndex(lstat(current), linked)).isSymbolicLink())
                throw new Error("Linked note rejected");
        }
        const resolved = await waitForIndex(realpath(target), linked);
        if (!isWithinRoots(resolved, [this.root]) || pathKey(resolved) !== pathKey(target))
            throw new Error("Outside vault");
        const details = await waitForIndex(lstat(target), linked);
        if (!details.isFile() || details.size > 262_144) throw new Error("Unsupported note size");
        return { target, details };
    }
    private async readRecord(id: string, signal?: AbortSignal): Promise<NoteRecord> {
        const linked = AbortSignal.any([
            this.lifetime.signal,
            ...(signal ? [signal] : []),
            AbortSignal.timeout(2000),
        ]);
        const before = await this.checkedPath(id, linked);
        const bytes = await waitForIndex(readFile(before.target, { signal: linked }), linked);
        const after = await this.checkedPath(id, linked);
        if (
            before.details.ino !== after.details.ino ||
            before.details.mtimeMs !== after.details.mtimeMs ||
            before.details.size !== after.details.size ||
            bytes.length > 262_144
        )
            throw new ObsidianError(
                "NOTE_CHANGED",
                "A nota mudou durante a leitura; consulte novamente.",
            );
        const markdown = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return {
            id,
            mtimeMs: after.details.mtimeMs,
            ctimeMs: after.details.ctimeMs,
            size: after.details.size,
            markdown,
            note: parseMarkdownNote(id, markdown),
        };
    }
    private async currentMetadata(record: NoteRecord, signal?: AbortSignal): Promise<boolean> {
        try {
            const { details } = await this.checkedPath(record.id, signal);
            return (
                details.mtimeMs === record.mtimeMs &&
                details.ctimeMs === record.ctimeMs &&
                details.size === record.size
            );
        } catch {
            signal?.throwIfAborted();
            return false;
        }
    }
    private summary(record: NoteRecord): NoteSummary {
        return {
            id: record.id,
            title: record.note.title,
            tags: [...record.note.tags],
            excerpt: record.note.text.slice(0, 360).trim(),
        };
    }
    private resolve(reference: string): NoteRecord {
        const query = normalizeNoteText(reference.trim().replace(/^\[\[|\]\]$/g, ""));
        const matches = this.paths.get(query) ?? this.names.get(query);
        if (matches && matches.size > 1)
            throw new ObsidianError(
                "NOTE_AMBIGUOUS",
                "Há mais de uma nota com esse nome. Informe o caminho relativo mostrado na busca.",
            );
        const id = matches?.values().next().value;
        const record = id ? this.records.get(id) : undefined;
        if (!record)
            throw new ObsidianError(
                "NOTE_NOT_FOUND",
                "Não encontrei essa nota no índice do vault.",
            );
        return record;
    }
    private rebuildReferences(): void {
        this.paths.clear();
        this.names.clear();
        const add = (map: Map<string, Set<string>>, name: string, id: string): void => {
            const key = normalizeNoteText(name);
            const ids = map.get(key) ?? new Set<string>();
            ids.add(id);
            map.set(key, ids);
        };
        for (const record of this.records.values()) {
            add(this.paths, record.id, record.id);
            add(this.paths, record.id.replace(/\.md$/i, ""), record.id);
            for (const name of [
                record.note.title,
                path.posix.basename(record.id, ".md"),
                ...record.note.aliases,
            ])
                add(this.names, name, record.id);
        }
    }
    private resolveLink(link: string, source: string): NoteRecord | null {
        const target = link.split("#")[0]!.trim();
        if (!target) return this.records.get(source) ?? null;
        if (/^[a-z][a-z\d+.-]*:|^[/\\]/i.test(target)) return null;
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
        try {
            return this.resolve(relative);
        } catch {
            /* Try vault-absolute wikilink name. */
        }
        try {
            return this.resolve(target);
        } catch {
            return null;
        }
    }
}
