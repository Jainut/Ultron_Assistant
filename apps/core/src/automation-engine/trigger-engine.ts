import { createTriggerEventId } from "./ids.ts";
import type {
    DailySchedule,
    IntervalSchedule,
    JsonObject,
    OnceSchedule,
    SystemStartupTrigger,
    TimeSchedule,
    TimeScheduleTrigger,
    Trigger,
    TriggerEvent,
} from "./types.ts";

interface ZonedParts {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
}

export class TriggerEngine {
    constructor(readonly defaultTimezone = "UTC") {
        assertTimezone(defaultTimezone);
    }

    validate(trigger: Trigger): void {
        if (trigger.type === "time.schedule") {
            this.validateSchedule((trigger as TimeScheduleTrigger).config.schedule);
            return;
        }
        if (trigger.type === "system.startup") {
            const { delayMs = 0 } = (trigger as SystemStartupTrigger).config;
            if (!Number.isFinite(delayMs) || delayMs < 0) {
                throw new RangeError("system.startup delayMs must be a non-negative number.");
            }
        }
    }

    /** Returns the first occurrence strictly after `after`. */
    nextRun(trigger: Trigger, after = new Date()): Date | null {
        if (Number.isNaN(after.getTime())) {
            throw new RangeError("Invalid reference date.");
        }
        if (trigger.type !== "time.schedule") {
            return null;
        }

        const schedule = (trigger as TimeScheduleTrigger).config.schedule;
        this.validateSchedule(schedule);
        switch (schedule.kind) {
            case "once":
                return this.nextOnce(schedule, after);
            case "interval":
                return this.nextInterval(schedule, after);
            case "daily":
                return this.nextDaily(schedule, after);
        }
    }

    timezoneFor(trigger: Trigger): string {
        if (trigger.type !== "time.schedule") {
            return this.defaultTimezone;
        }
        const schedule = (trigger as TimeScheduleTrigger).config.schedule;
        return schedule.timezone ?? this.defaultTimezone;
    }

    matches(trigger: Trigger, event: TriggerEvent): boolean {
        return trigger.type === event.type;
    }

    startupDelay(trigger: Trigger): number | null {
        if (trigger.type !== "system.startup") {
            return null;
        }
        this.validate(trigger);
        return (trigger as SystemStartupTrigger).config.delayMs ?? 0;
    }

    createEvent<TData extends JsonObject>(
        type: string,
        data: TData,
        occurredAt = new Date(),
    ): TriggerEvent<string, TData> {
        if (type.trim().length === 0) {
            throw new TypeError("Trigger event type cannot be empty.");
        }
        if (Number.isNaN(occurredAt.getTime())) {
            throw new RangeError("Invalid trigger event date.");
        }
        return {
            id: createTriggerEventId(),
            type,
            occurredAt: occurredAt.toISOString(),
            data,
        };
    }

    private validateSchedule(schedule: TimeSchedule): void {
        switch (schedule.kind) {
            case "once":
                parseScheduledDate(schedule.at, schedule.timezone ?? this.defaultTimezone);
                return;
            case "interval":
                if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
                    throw new RangeError("Interval everyMs must be greater than zero.");
                }
                if (schedule.startAt !== undefined) {
                    parseScheduledDate(
                        schedule.startAt,
                        schedule.timezone ?? this.defaultTimezone,
                    );
                }
                if (schedule.endAt !== undefined) {
                    parseScheduledDate(
                        schedule.endAt,
                        schedule.timezone ?? this.defaultTimezone,
                    );
                }
                return;
            case "daily": {
                parseClockTime(schedule.time);
                assertTimezone(schedule.timezone);
                if (
                    schedule.daysOfWeek !== undefined
                    && (
                        schedule.daysOfWeek.length === 0
                        || schedule.daysOfWeek.some(
                            (day) => !Number.isInteger(day) || day < 0 || day > 6,
                        )
                    )
                ) {
                    throw new RangeError("daysOfWeek must contain values from 0 through 6.");
                }
            }
        }
    }

    private nextOnce(schedule: OnceSchedule, after: Date): Date | null {
        const at = parseScheduledDate(
            schedule.at,
            schedule.timezone ?? this.defaultTimezone,
        );
        return at.getTime() > after.getTime() ? at : null;
    }

    private nextInterval(schedule: IntervalSchedule, after: Date): Date | null {
        const timezone = schedule.timezone ?? this.defaultTimezone;
        const anchor = schedule.startAt === undefined
            ? after.getTime() + schedule.everyMs
            : parseScheduledDate(schedule.startAt, timezone).getTime();
        const afterMs = after.getTime();
        const nextMs = anchor > afterMs
            ? anchor
            : anchor
                + (Math.floor((afterMs - anchor) / schedule.everyMs) + 1)
                    * schedule.everyMs;

        if (schedule.endAt !== undefined) {
            const endMs = parseScheduledDate(schedule.endAt, timezone).getTime();
            if (nextMs > endMs) {
                return null;
            }
        }
        return new Date(nextMs);
    }

    private nextDaily(schedule: DailySchedule, after: Date): Date | null {
        const clock = parseClockTime(schedule.time);
        const currentLocal = zonedParts(after, schedule.timezone);
        const allowedDays = new Set(schedule.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6]);

        for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
            const calendarDate = new Date(Date.UTC(
                currentLocal.year,
                currentLocal.month - 1,
                currentLocal.day + dayOffset,
            ));
            if (!allowedDays.has(calendarDate.getUTCDay())) {
                continue;
            }

            const desired: ZonedParts = {
                year: calendarDate.getUTCFullYear(),
                month: calendarDate.getUTCMonth() + 1,
                day: calendarDate.getUTCDate(),
                hour: clock.hour,
                minute: clock.minute,
                second: clock.second,
            };
            const candidate = zonedDateTimeToUtc(desired, schedule.timezone);
            if (candidate !== null && candidate.getTime() > after.getTime()) {
                return candidate;
            }
        }
        return null;
    }
}

function parseClockTime(value: string): {
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
} {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
    if (match === null) {
        throw new RangeError("Daily time must use HH:mm or HH:mm:ss.");
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) {
        throw new RangeError("Daily time is outside the valid clock range.");
    }
    return { hour, minute, second };
}

function parseScheduledDate(value: string, timezone: string): Date {
    const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    if (hasExplicitOffset) {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
            throw new RangeError(`Invalid scheduled date: ${value}`);
        }
        return parsed;
    }

    const localMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (localMatch === null) {
        throw new RangeError(
            "Scheduled dates require an ISO offset or YYYY-MM-DDTHH:mm local format.",
        );
    }
    assertTimezone(timezone);
    const parsed = zonedDateTimeToUtc({
        year: Number(localMatch[1]),
        month: Number(localMatch[2]),
        day: Number(localMatch[3]),
        hour: Number(localMatch[4]),
        minute: Number(localMatch[5]),
        second: Number(localMatch[6] ?? 0),
    }, timezone);
    if (parsed === null) {
        throw new RangeError(`The local scheduled time does not exist in ${timezone}.`);
    }
    return parsed;
}

function assertTimezone(timezone: string): void {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
        throw new RangeError(`Invalid IANA timezone: ${timezone}`);
    }
}

function zonedParts(date: Date, timezone: string): ZonedParts {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    });
    const values = new Map(
        formatter.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return {
        year: Number(values.get("year")),
        month: Number(values.get("month")),
        day: Number(values.get("day")),
        hour: Number(values.get("hour")),
        minute: Number(values.get("minute")),
        second: Number(values.get("second")),
    };
}

/** Convert an IANA-zone wall-clock value without depending on a date library. */
function zonedDateTimeToUtc(parts: ZonedParts, timezone: string): Date | null {
    const desiredAsUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
    );
    let guess = desiredAsUtc;

    for (let iteration = 0; iteration < 4; iteration += 1) {
        const actual = zonedParts(new Date(guess), timezone);
        const actualAsUtc = Date.UTC(
            actual.year,
            actual.month - 1,
            actual.day,
            actual.hour,
            actual.minute,
            actual.second,
        );
        const adjustment = desiredAsUtc - actualAsUtc;
        if (adjustment === 0) {
            break;
        }
        guess += adjustment;
    }

    const result = new Date(guess);
    const roundTrip = zonedParts(result, timezone);
    return sameParts(roundTrip, parts) ? result : null;
}

function sameParts(left: ZonedParts, right: ZonedParts): boolean {
    return left.year === right.year
        && left.month === right.month
        && left.day === right.day
        && left.hour === right.hour
        && left.minute === right.minute
        && left.second === right.second;
}
