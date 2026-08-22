import type { JsonObject } from "../automation-engine/types.ts";

export type NotificationPriority = "low" | "normal" | "high";

export type NotificationTrust = "system" | "untrusted-derived";

export type NotificationStatus = "pending" | "delivered" | "read";

export interface NotificationRecord {
    readonly id: string;
    readonly title: string;
    readonly message: string;
    readonly source: string;
    readonly priority: NotificationPriority;
    readonly trust: NotificationTrust;
    readonly status: NotificationStatus;
    readonly createdAt: string;
    readonly deliveredAt?: string;
    readonly readAt?: string;
    readonly dedupeKey?: string;
    readonly metadata?: JsonObject;
}

export interface NotificationPublishInput {
    readonly title: string;
    readonly message: string;
    readonly source: string;
    readonly priority?: NotificationPriority;
    /** Seguro por padrão; produtores internos devem declarar "system" explicitamente. */
    readonly trust?: NotificationTrust;
    readonly dedupeKey?: string;
    readonly metadata?: JsonObject;
}

export interface NotificationCenterOptions {
    readonly filePath: string;
    readonly now?: () => Date;
    readonly createId?: () => string;
}

export interface NotificationPublishOptions {
    readonly signal?: AbortSignal;
}

export interface NotificationListOptions {
    readonly status?: NotificationStatus;
    readonly limit?: number;
}

export interface NotificationWaitOptions {
    readonly signal?: AbortSignal;
    /** IDs já tentados nesta execução; continuam pendentes para retry após restart. */
    readonly excludeIds?: readonly string[];
}
