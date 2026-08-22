import type { JsonObject } from "../../automation-engine/types.ts";
import type {
    CalendarEvent,
    CalendarProvider,
} from "../../providers/calendar-provider.ts";
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

export interface CalendarReminderInput extends JsonObject {
    readonly reminderId: string;
    readonly leadMinutes: number;
    readonly calendarId?: string;
    readonly includeAllDay?: boolean;
    readonly timeZone?: string;
    readonly maxResults?: number;
}

export interface CalendarReminderOutput extends JsonObject {
    readonly reminderId: string;
    readonly checked: number;
    readonly matched: number;
    readonly notified: number;
}

export interface CalendarReminderFactoryOptions {
    readonly calendar: CalendarProvider;
    readonly notifications: NotificationPublisher;
    readonly state: MonitorStateStore;
    readonly now?: () => Date;
}

const queue = new KeyedExecutionQueue();

export function createCalendarReminderAction(
    options: CalendarReminderFactoryOptions,
): MonitorActionDefinition<CalendarReminderInput, CalendarReminderOutput> {
    const now = options.now ?? (() => new Date());

    return {
        type: "calendar.reminderScan",
        category: "calendar",
        execute: async (input, context) => await queue.run(
            calendarStateId(),
            async () => {
                context.signal?.throwIfAborted();
                validateCalendarReminderInput(input);
                const scanStartedAt = now();
                if (!Number.isFinite(scanStartedAt.getTime())) {
                    throw new TypeError("Relógio do monitor retornou uma data inválida.");
                }
                const timeZone = input.timeZone?.trim() || "UTC";
                const scanEndsAt = new Date(
                    scanStartedAt.getTime() + input.leadMinutes * 60_000,
                );
                const page = await options.calendar.listEvents({
                    calendarId: clean(input.calendarId),
                    timeMin: providerDateTime(scanStartedAt, timeZone),
                    timeMax: providerDateTime(scanEndsAt, timeZone),
                    maxResults: clamp(input.maxResults ?? 100, 1, 100),
                    includeCancelled: false,
                    signal: context.signal,
                });
                context.signal?.throwIfAborted();

                const matching = page.items
                    .filter(event => event.status !== "cancelled")
                    .filter(event => input.includeAllDay === true || event.start.allDay !== true)
                    .filter(event => event.start.date.getTime() >= scanStartedAt.getTime())
                    .filter(event => event.start.date.getTime() <= scanEndsAt.getTime())
                    .sort((left, right) => left.start.date.getTime() - right.start.date.getTime());
                const stateId = calendarStateId();
                let seen = await loadSeen(options.state, stateId);
                let notified = 0;

                for (const event of matching) {
                    context.signal?.throwIfAborted();
                    const seenKey = eventSeenKey(event, input.leadMinutes);
                    if (seen.has(seenKey)) continue;

                    await options.notifications.publish({
                        title: "Lembrete de calendário",
                        message: calendarNotificationMessage(event, scanStartedAt),
                        source: options.calendar.id,
                        priority: "high",
                        trust: "untrusted-derived",
                        dedupeKey: `calendar-reminder:${seenKey}`,
                        metadata: {
                            reminderId: input.reminderId,
                            eventId: event.id,
                            calendarId: event.calendarId,
                            eventStart: event.start.iso,
                            leadMinutes: input.leadMinutes,
                        },
                    }, { signal: context.signal });

                    // Persist only after successful publication.
                    seen = await rememberSeen(options.state, stateId, seen, seenKey, now());
                    notified += 1;
                }

                return {
                    reminderId: input.reminderId,
                    checked: page.items.length,
                    matched: matching.length,
                    notified,
                };
            },
            context.signal,
        ),
    };
}

function eventSeenKey(event: CalendarEvent, leadMinutes: number): string {
    // IDs de eventos não são garantidos como globais entre calendários.
    // Sem calendarId, duas agendas poderiam suprimir lembretes uma da outra.
    return `${event.calendarId}:${event.id}:${event.start.iso}:${leadMinutes}`;
}

function calendarNotificationMessage(event: CalendarEvent, now: Date): string {
    const minutes = Math.max(
        0,
        Math.ceil((event.start.date.getTime() - now.getTime()) / 60_000),
    );
    const summary = externalDisplayText(event.summary.value || "evento sem título", 180);
    return `${summary} começa em aproximadamente ${minutes} minuto(s).`;
}

function validateCalendarReminderInput(input: CalendarReminderInput): void {
    if (!input.reminderId.trim()) throw new TypeError("reminderId é obrigatório.");
    if (
        !Number.isFinite(input.leadMinutes)
        || input.leadMinutes < 1
        || input.leadMinutes > 10_080
    ) {
        throw new RangeError("leadMinutes deve estar entre 1 e 10080.");
    }
    if (input.maxResults !== undefined && (
        !Number.isSafeInteger(input.maxResults)
        || input.maxResults < 1
        || input.maxResults > 100
    )) {
        throw new RangeError("maxResults deve estar entre 1 e 100.");
    }
}

function calendarStateId(): string {
    // Global per state store: two identical reminder automations still notify
    // only once for the same event start and lead window.
    return "calendar.reminder:dedupe";
}

function clean(value: string | undefined): string | undefined {
    const cleaned = value?.trim();
    return cleaned || undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
