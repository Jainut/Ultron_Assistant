import { randomUUID } from "node:crypto";
import {
    basename,
    dirname,
    join,
    resolve,
} from "node:path";
import {
    mkdir,
    open,
    readFile,
    rename,
    unlink,
} from "node:fs/promises";

import type {
    Automation,
    Job,
    PersistedEntity,
} from "./types.ts";

interface StoreDocument<T> {
    readonly schemaVersion: 1;
    readonly updatedAt: string;
    readonly records: T[];
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function isMissingFile(error: unknown): boolean {
    return error instanceof Error
        && "code" in error
        && error.code === "ENOENT";
}

/**
 * A small process-local JSON store. Mutations are serialized and committed by
 * renaming a fully flushed temporary file in the same directory.
 */
export class AtomicJsonStore<T extends PersistedEntity> {
    readonly filePath: string;

    private loaded = false;
    private records = new Map<string, T>();
    private operationTail: Promise<void> = Promise.resolve();

    constructor(filePath: string) {
        this.filePath = resolve(filePath);
    }

    async list(): Promise<T[]> {
        return this.exclusive(async () => {
            await this.loadIfNeeded();
            return [...this.records.values()].map(clone);
        });
    }

    async get(id: string): Promise<T | undefined> {
        return this.exclusive(async () => {
            await this.loadIfNeeded();
            const value = this.records.get(id);
            return value === undefined ? undefined : clone(value);
        });
    }

    async put(record: T): Promise<T> {
        return this.exclusive(async () => {
            await this.loadIfNeeded();
            const nextRecords = new Map(this.records);
            nextRecords.set(record.id, clone(record));
            await this.persist(nextRecords);
            this.records = nextRecords;
            return clone(record);
        });
    }

    async putMany(records: readonly T[]): Promise<T[]> {
        return this.exclusive(async () => {
            await this.loadIfNeeded();
            const nextRecords = new Map(this.records);
            for (const record of records) {
                nextRecords.set(record.id, clone(record));
            }
            await this.persist(nextRecords);
            this.records = nextRecords;
            return records.map(clone);
        });
    }

    async delete(id: string): Promise<boolean> {
        return this.exclusive(async () => {
            await this.loadIfNeeded();
            const nextRecords = new Map(this.records);
            const deleted = nextRecords.delete(id);
            if (deleted) {
                await this.persist(nextRecords);
                this.records = nextRecords;
            }
            return deleted;
        });
    }

    async update(
        id: string,
        updater: (current: T) => T,
    ): Promise<T | undefined> {
        return this.exclusive(async () => {
            await this.loadIfNeeded();
            const current = this.records.get(id);
            if (current === undefined) {
                return undefined;
            }

            const updated = updater(clone(current));
            if (updated.id !== id) {
                throw new Error("A store update cannot change the record ID.");
            }

            const nextRecords = new Map(this.records);
            nextRecords.set(id, clone(updated));
            await this.persist(nextRecords);
            this.records = nextRecords;
            return clone(updated);
        });
    }

    /** Clear only the in-memory cache; useful after an external restore. */
    async reload(): Promise<void> {
        await this.exclusive(async () => {
            this.loaded = false;
            this.records.clear();
            await this.loadIfNeeded();
        });
    }

    private async loadIfNeeded(): Promise<void> {
        if (this.loaded) {
            return;
        }

        try {
            const serialized = await readFile(this.filePath, "utf8");
            const document = JSON.parse(serialized) as Partial<StoreDocument<unknown>>;
            if (document.schemaVersion !== 1 || !Array.isArray(document.records)) {
                throw new Error(`Invalid store document: ${this.filePath}`);
            }

            const records = new Map<string, T>();
            for (const candidate of document.records) {
                if (
                    candidate === null
                    || typeof candidate !== "object"
                    || !("id" in candidate)
                    || typeof candidate.id !== "string"
                ) {
                    throw new Error(`Invalid record in store: ${this.filePath}`);
                }
                if (records.has(candidate.id)) {
                    throw new Error(`Duplicate record ID ${candidate.id} in ${this.filePath}`);
                }
                records.set(candidate.id, candidate as T);
            }
            this.records = records;
        } catch (error) {
            if (!isMissingFile(error)) {
                throw error;
            }
            this.records = new Map<string, T>();
        }

        this.loaded = true;
    }

    private async persist(records: ReadonlyMap<string, T>): Promise<void> {
        const parentDirectory = dirname(this.filePath);
        await mkdir(parentDirectory, { recursive: true });

        const temporaryPath = join(
            parentDirectory,
            `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
        );
        const document: StoreDocument<T> = {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            records: [...records.values()].map(clone),
        };
        const serialized = `${JSON.stringify(document, null, 2)}\n`;
        try {
            const fileHandle = await open(temporaryPath, "wx", 0o600);
            try {
                await fileHandle.writeFile(serialized, "utf8");
                await fileHandle.sync();
            } finally {
                await fileHandle.close();
            }
            await rename(temporaryPath, this.filePath);
        } finally {
            await unlink(temporaryPath).catch(() => undefined);
        }
    }

    private async exclusive<TResult>(
        operation: () => Promise<TResult>,
    ): Promise<TResult> {
        const previous = this.operationTail;
        let release!: () => void;
        this.operationTail = new Promise<void>((resolveOperation) => {
            release = resolveOperation;
        });

        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

export class AutomationStore extends AtomicJsonStore<Automation> {}

export class JobStore extends AtomicJsonStore<Job> {}
