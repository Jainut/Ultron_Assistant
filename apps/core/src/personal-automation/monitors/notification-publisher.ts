import type { JsonObject } from "../../automation-engine/types.ts";

export interface MonitorNotification {
    readonly title: string;
    readonly message: string;
    readonly source: string;
    readonly priority?: "low" | "normal" | "high";
    /** External mail/calendar text is always published with this trust marker. */
    readonly trust: "untrusted-derived";
    readonly dedupeKey: string;
    /** Only opaque IDs and timestamps belong here, never executable actions. */
    readonly metadata?: JsonObject;
}

export interface NotificationPublishContext {
    readonly signal?: AbortSignal;
}

/** Structurally compatible with NotificationCenter without coupling monitors to it. */
export interface NotificationPublisher {
    publish(
        notification: MonitorNotification,
        context?: NotificationPublishContext,
    ): Promise<unknown>;
}

/** Render remote text for a notification, never as an action or instruction. */
export function externalDisplayText(value: string, maxLength = 240): string {
    return value
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}
