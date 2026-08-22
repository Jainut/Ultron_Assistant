import { randomUUID } from "node:crypto";

import { AtomicJsonStore } from "../automation-engine/stores.ts";
import type {
    NotificationCenterOptions,
    NotificationListOptions,
    NotificationPublishInput,
    NotificationPublishOptions,
    NotificationRecord,
    NotificationWaitOptions,
} from "./types.ts";

interface NotificationWaiter {
    readonly id: number;
    readonly resolve: (notification: NotificationRecord) => void;
    readonly reject: (reason: unknown) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
    readonly excludedIds: ReadonlySet<string>;
}

type WaitOutcome =
    | { readonly kind: "record"; readonly record: NotificationRecord }
    | { readonly kind: "wait"; readonly promise: Promise<NotificationRecord> };

function defaultCreateId(): string {
    return `notification_${randomUUID()}`;
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function assertNonEmpty(value: string, field: string): void {
    if (value.trim().length === 0) {
        throw new Error(`${field} cannot be empty.`);
    }
}

/**
 * Persistent, process-local notification inbox.
 *
 * Consumers receive pending records with at-least-once semantics: delivery is
 * only acknowledged by calling markDelivered. This makes a notification that
 * was not acknowledged recoverable by waitForNext after a process restart.
 */
export class NotificationCenter {
    readonly filePath: string;

    private readonly store: AtomicJsonStore<NotificationRecord>;
    private readonly now: () => Date;
    private readonly createId: () => string;
    private readonly waiters = new Map<number, NotificationWaiter>();
    private nextWaiterId = 1;
    private operationTail: Promise<void> = Promise.resolve();

    constructor(options: NotificationCenterOptions) {
        assertNonEmpty(options.filePath, "filePath");
        this.store = new AtomicJsonStore<NotificationRecord>(options.filePath);
        this.filePath = this.store.filePath;
        this.now = options.now ?? (() => new Date());
        this.createId = options.createId ?? defaultCreateId;
    }

    async publish(
        input: NotificationPublishInput,
        options: NotificationPublishOptions = {},
    ): Promise<NotificationRecord> {
        validatePublishInput(input);
        options.signal?.throwIfAborted();

        const outcome = await this.exclusive(async () => {
            options.signal?.throwIfAborted();
            const records = await this.store.list();
            options.signal?.throwIfAborted();
            if (input.dedupeKey !== undefined) {
                const duplicate = records.find(
                    (record) => record.dedupeKey === input.dedupeKey,
                );
                if (duplicate !== undefined) {
                    return { record: duplicate, created: false } as const;
                }
            }

            const id = this.createId();
            assertNonEmpty(id, "notification id");
            if (records.some((record) => record.id === id)) {
                throw new Error(`Notification ID already exists: ${id}`);
            }

            const record: NotificationRecord = {
                id,
                title: input.title,
                message: input.message,
                source: input.source,
                priority: input.priority ?? "normal",
                // Um produtor que esquecer a classificação nunca ganha confiança
                // de sistema implicitamente.
                trust: input.trust ?? "untrusted-derived",
                status: "pending",
                createdAt: this.timestamp(),
                ...(input.dedupeKey === undefined
                    ? {}
                    : { dedupeKey: input.dedupeKey }),
                ...(input.metadata === undefined
                    ? {}
                    : { metadata: input.metadata }),
            };

            // AtomicJsonStore cannot cancel an in-progress filesystem commit.
            // Honor cancellation immediately before that irreversible boundary.
            options.signal?.throwIfAborted();
            return {
                record: await this.store.put(record),
                created: true,
            } as const;
        });

        if (outcome.created) {
            this.resolveWaiters(outcome.record);
        }
        return outcome.record;
    }

    async list(options: NotificationListOptions = {}): Promise<NotificationRecord[]> {
        validateLimit(options.limit);
        return this.exclusive(async () => {
            let records = await this.store.list();
            if (options.status !== undefined) {
                records = records.filter((record) => record.status === options.status);
            }
            if (options.limit !== undefined) {
                records = records.slice(0, options.limit);
            }
            return records;
        });
    }

    async markDelivered(id: string): Promise<NotificationRecord | undefined> {
        assertNonEmpty(id, "notification id");
        return this.exclusive(() => this.store.update(id, (current) => {
            if (current.status !== "pending") {
                return current;
            }
            return {
                ...current,
                status: "delivered",
                deliveredAt: this.timestamp(),
            };
        }));
    }

    async markRead(id: string): Promise<NotificationRecord | undefined> {
        assertNonEmpty(id, "notification id");
        return this.exclusive(() => this.store.update(id, (current) => {
            if (current.status === "read") {
                return current;
            }
            const markedAt = this.timestamp();
            return {
                ...current,
                status: "read",
                deliveredAt: current.deliveredAt ?? markedAt,
                readAt: markedAt,
            };
        }));
    }

    async waitForNext(
        options: NotificationWaitOptions = {},
    ): Promise<NotificationRecord> {
        options.signal?.throwIfAborted();
        const excludedIds = new Set(options.excludeIds ?? []);

        const outcome = await this.exclusive<WaitOutcome>(async () => {
            options.signal?.throwIfAborted();
            const records = await this.store.list();
            options.signal?.throwIfAborted();
            const pending = records.find(
                (record) => record.status === "pending" && !excludedIds.has(record.id),
            );
            if (pending !== undefined) {
                return { kind: "record", record: pending };
            }

            options.signal?.throwIfAborted();
            const promise = this.addWaiter(options.signal, excludedIds);
            return { kind: "wait", promise };
        });

        return outcome.kind === "record"
            ? outcome.record
            : await outcome.promise;
    }

    private addWaiter(
        signal?: AbortSignal,
        excludedIds: ReadonlySet<string> = new Set(),
    ): Promise<NotificationRecord> {
        const id = this.nextWaiterId;
        this.nextWaiterId += 1;

        let resolveWaiter!: (notification: NotificationRecord) => void;
        let rejectWaiter!: (reason: unknown) => void;
        const promise = new Promise<NotificationRecord>((resolve, reject) => {
            resolveWaiter = resolve;
            rejectWaiter = reject;
        });
        // Abort can race with the return from the serialized section. Attaching
        // an observer here prevents a transient unhandled-rejection warning;
        // callers still receive the original rejecting promise.
        void promise.catch(() => undefined);

        const onAbort = signal === undefined
            ? undefined
            : () => {
                const waiter = this.waiters.get(id);
                if (waiter === undefined) {
                    return;
                }
                this.waiters.delete(id);
                rejectWaiter(abortReason(signal));
            };
        const waiter: NotificationWaiter = {
            id,
            resolve: resolveWaiter,
            reject: rejectWaiter,
            excludedIds,
            ...(signal === undefined ? {} : { signal }),
            ...(onAbort === undefined ? {} : { onAbort }),
        };
        this.waiters.set(id, waiter);
        signal?.addEventListener("abort", onAbort!, { once: true });

        // The signal can become aborted between throwIfAborted and listener
        // registration, so close that race explicitly.
        if (signal?.aborted) {
            onAbort?.();
        }
        return promise;
    }

    private resolveWaiters(notification: NotificationRecord): void {
        for (const waiter of [...this.waiters.values()]) {
            if (waiter.excludedIds.has(notification.id)) continue;
            this.waiters.delete(waiter.id);
            if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
                waiter.signal.removeEventListener("abort", waiter.onAbort);
            }
            waiter.resolve(structuredClone(notification));
        }
    }

    private timestamp(): string {
        return this.now().toISOString();
    }

    private async exclusive<TResult>(
        operation: () => Promise<TResult>,
    ): Promise<TResult> {
        const previous = this.operationTail;
        let release!: () => void;
        this.operationTail = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function validatePublishInput(input: NotificationPublishInput): void {
    assertNonEmpty(input.title, "title");
    assertNonEmpty(input.message, "message");
    assertNonEmpty(input.source, "source");
    if (input.dedupeKey !== undefined) {
        assertNonEmpty(input.dedupeKey, "dedupeKey");
    }
}

function validateLimit(limit: number | undefined): void {
    if (
        limit !== undefined
        && (!Number.isSafeInteger(limit) || limit < 0)
    ) {
        throw new Error("Notification list limit must be a non-negative safe integer.");
    }
}
