import type { JsonObject } from "../../automation-engine/types.ts";
import type {
    MailMessageSummary,
    MailProvider,
} from "../../providers/mail-provider.ts";
import { providerDateTime } from "../../providers/types.ts";
import { KeyedExecutionQueue } from "./keyed-execution.ts";
import type { MonitorActionDefinition } from "./monitor-action.ts";
import {
    loadSeen,
    rememberSeen,
    type MonitorStateStore,
} from "./monitor-state.ts";
import {
    externalDisplayText,
    type NotificationPublisher,
} from "./notification-publisher.ts";

export interface MailWatchInput extends JsonObject {
    readonly watchId: string;
    readonly threadId?: string;
    readonly from?: string;
    readonly subject?: string;
    readonly query?: string;
    readonly unreadOnly?: boolean;
    /** Absolute ISO timestamp. Watches created by tools default this to creation time. */
    readonly createdAfter?: string;
    readonly timeZone?: string;
    readonly maxResults?: number;
}

export interface MailWatchOutput extends JsonObject {
    readonly watchId: string;
    readonly checked: number;
    readonly matched: number;
    readonly notified: number;
}

export interface MailWatchFactoryOptions {
    readonly mail: MailProvider;
    readonly notifications: NotificationPublisher;
    readonly state: MonitorStateStore;
    readonly now?: () => Date;
}

const queue = new KeyedExecutionQueue();

export function createMailWatchAction(
    options: MailWatchFactoryOptions,
): MonitorActionDefinition<MailWatchInput, MailWatchOutput> {
    const now = options.now ?? (() => new Date());

    return {
        type: "mail.watch",
        category: "mail",
        execute: async (input, context) => await queue.run(
            mailStateId(input.watchId),
            async () => {
                context.signal?.throwIfAborted();
                validateMailWatchInput(input);
                const threadMode = Boolean(clean(input.threadId));
                const messages = await findMessages(options.mail, input, context.signal);
                context.signal?.throwIfAborted();
                const matching = messages
                    .filter(message => matchesMailFilters(message, input, threadMode))
                    .sort((left, right) => (
                        left.receivedAt.date.getTime() - right.receivedAt.date.getTime()
                    ));
                const stateId = mailStateId(input.watchId);
                let seen = await loadSeen(options.state, stateId);
                let notified = 0;

                for (const message of matching) {
                    context.signal?.throwIfAborted();
                    if (seen.has(message.id)) continue;

                    await options.notifications.publish({
                        title: "Novo email monitorado",
                        message: mailNotificationMessage(message),
                        source: options.mail.id,
                        priority: "normal",
                        trust: "untrusted-derived",
                        dedupeKey: `mail-watch:${input.watchId}:${message.id}`,
                        metadata: {
                            watchId: input.watchId,
                            messageId: message.id,
                            threadId: message.threadId,
                            receivedAt: message.receivedAt.iso,
                        },
                    }, { signal: context.signal });

                    // Publish first, then commit seen. A failed notification is retried.
                    seen = await rememberSeen(options.state, stateId, seen, message.id, now());
                    notified += 1;
                }

                return {
                    watchId: input.watchId,
                    checked: messages.length,
                    matched: matching.length,
                    notified,
                };
            },
            context.signal,
        ),
    };
}

async function findMessages(
    mail: MailProvider,
    input: MailWatchInput,
    signal?: AbortSignal,
): Promise<readonly MailMessageSummary[]> {
    const threadId = clean(input.threadId);
    if (threadId) {
        const thread = await mail.getThread(threadId, { signal });
        return thread.messages;
    }

    const newerThan = input.createdAfter
        ? providerDateTime(input.createdAfter, input.timeZone || "UTC")
        : undefined;
    const page = await mail.searchMessages({
        query: clean(input.query),
        from: clean(input.from),
        subject: clean(input.subject),
        unreadOnly: input.unreadOnly,
        newerThan,
        maxResults: clamp(input.maxResults ?? 100, 1, 100),
        signal,
    });
    return page.items;
}

function matchesMailFilters(
    message: MailMessageSummary,
    input: MailWatchInput,
    threadMode: boolean,
): boolean {
    if (input.unreadOnly && !message.unread) return false;
    if (
        input.createdAfter
        && message.receivedAt.date.getTime() < Date.parse(input.createdAfter)
    ) {
        return false;
    }

    const from = normalized(clean(input.from));
    if (from) {
        const senders = message.from.flatMap(address => [
            address.address.value,
            address.name?.value ?? "",
        ]).map(normalized);
        if (!senders.some(sender => sender.includes(from))) return false;
    }

    const subject = normalized(clean(input.subject));
    if (subject && !normalized(message.subject.value).includes(subject)) return false;

    // Gmail interprets its own query language in search mode. For a direct
    // thread watch, use metadata-only text matching and never inspect its body.
    const query = threadMode ? normalized(clean(input.query)) : "";
    if (query) {
        const metadata = [
            message.subject.value,
            message.snippet.value,
            ...message.from.flatMap(address => [
                address.address.value,
                address.name?.value ?? "",
            ]),
        ].map(normalized).join(" ");
        if (!metadata.includes(query)) return false;
    }
    return true;
}

function mailNotificationMessage(message: MailMessageSummary): string {
    const sender = externalDisplayText(
        message.from[0]?.name?.value
        || message.from[0]?.address.value
        || "remetente desconhecido",
        100,
    );
    const subject = externalDisplayText(message.subject.value || "sem assunto", 160);
    return `Novo email de ${sender}: ${subject}`;
}

function validateMailWatchInput(input: MailWatchInput): void {
    if (!input.watchId.trim()) throw new TypeError("watchId é obrigatório.");
    if (input.createdAfter) {
        if (!hasExplicitOffset(input.createdAfter) || !Number.isFinite(Date.parse(input.createdAfter))) {
            throw new TypeError("createdAfter deve ser uma data ISO absoluta.");
        }
    }
    if (input.maxResults !== undefined && (
        !Number.isSafeInteger(input.maxResults)
        || input.maxResults < 1
        || input.maxResults > 100
    )) {
        throw new RangeError("maxResults deve estar entre 1 e 100.");
    }
}

function mailStateId(watchId: string): string {
    return `mail.watch:${watchId.trim()}`;
}

function clean(value: string | undefined): string | undefined {
    const cleaned = value?.trim();
    return cleaned || undefined;
}

function normalized(value: string | undefined): string {
    return (value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
}

function hasExplicitOffset(value: string): boolean {
    return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
