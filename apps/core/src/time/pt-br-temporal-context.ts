const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

export type TemporalGranularity =
    | "minute"
    | "hour"
    | "day"
    | "day-period"
    | "week"
    | "relative";

export interface AbsoluteTimeRange {
    readonly start: Date;
    /** Exclusive upper bound. */
    readonly endExclusive: Date;
    readonly startIso: string;
    readonly endExclusiveIso: string;
}

export interface TemporalResolution {
    readonly sourceText: string;
    readonly matchedText: readonly string[];
    readonly timeZone: string;
    readonly kind: "instant" | "interval";
    readonly granularity: TemporalGranularity;
    readonly allDay: boolean;
    /** Present when the expression identifies an exact due/start time. */
    readonly instant?: Date;
    readonly instantIso?: string;
    /** Always present so calendar searches can consume the result directly. */
    readonly range: AbsoluteTimeRange;
    readonly localDate: string;
    readonly localTime?: string;
}

export interface PtBrTemporalContextOptions {
    readonly timeZone?: string;
    /** Injectable clock. It must return an absolute instant. */
    readonly now?: () => Date;
    readonly periods?: Partial<Record<DayPeriod, readonly [startHour: number, endHour: number]>>;
}

export interface ResolveTemporalOptions {
    /** Defaults to true for a time without an explicit date. */
    readonly preferFuture?: boolean;
}

export type DayPeriod = "morning" | "afternoon" | "night";

interface CivilDate {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

interface CivilDateTime extends CivilDate {
    readonly hour: number;
    readonly minute: number;
    readonly second: number;
    readonly millisecond: number;
}

interface ClockTime {
    readonly hour: number;
    readonly minute: number;
    readonly matched: string;
}

interface RelativeOffset {
    readonly amount: number;
    readonly unit: "hour" | "day";
    readonly matched: string;
}

const DEFAULT_PERIODS: Record<DayPeriod, readonly [number, number]> = {
    morning: [6, 12],
    afternoon: [12, 18],
    night: [18, 24],
};

const WEEKDAYS: readonly { readonly index: number; readonly pattern: RegExp }[] = [
    { index: 0, pattern: /\bdomingo\b/ },
    { index: 1, pattern: /\bsegunda(?:-feira)?\b/ },
    { index: 2, pattern: /\bterca(?:-feira)?\b/ },
    { index: 3, pattern: /\bquarta(?:-feira)?\b/ },
    { index: 4, pattern: /\bquinta(?:-feira)?\b/ },
    { index: 5, pattern: /\bsexta(?:-feira)?\b/ },
    { index: 6, pattern: /\bsabado\b/ },
];

const SIMPLE_NUMBERS: Readonly<Record<string, number>> = {
    um: 1,
    uma: 1,
    dois: 2,
    duas: 2,
    tres: 3,
    quatro: 4,
    cinco: 5,
    seis: 6,
    sete: 7,
    oito: 8,
    nove: 9,
    dez: 10,
    onze: 11,
    doze: 12,
    treze: 13,
    quatorze: 14,
    catorze: 14,
    quinze: 15,
    dezesseis: 16,
    dezassete: 17,
    dezessete: 17,
    dezoito: 18,
    dezenove: 19,
    vinte: 20,
    trinta: 30,
};

const NUMBER_PATTERN =
    "(?:\\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|quatorze|catorze|quinze|dezesseis|dezassete|dezessete|dezoito|dezenove|vinte(?:\\s+e\\s+(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove))?|trinta)";

/**
 * Lightweight pt-BR temporal resolver for commands, tasks and calendar tools.
 * It deliberately returns absolute instants; no consumer has to reinterpret a
 * relative phrase later with a different clock or timezone.
 */
export class PtBrTemporalContext {
    readonly timeZone: string;

    private readonly clock: () => Date;
    private readonly periods: Record<DayPeriod, readonly [number, number]>;

    constructor(options: PtBrTemporalContextOptions = {}) {
        this.timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
        assertValidTimeZone(this.timeZone);
        this.clock = options.now ?? (() => new Date());
        this.periods = {
            morning: options.periods?.morning ?? DEFAULT_PERIODS.morning,
            afternoon: options.periods?.afternoon ?? DEFAULT_PERIODS.afternoon,
            night: options.periods?.night ?? DEFAULT_PERIODS.night,
        };
        validatePeriods(this.periods);
    }

    resolve(input: string, options: ResolveTemporalOptions = {}): TemporalResolution | null {
        const sourceText = input.trim();
        if (!sourceText) {
            return null;
        }

        const normalized = normalize(sourceText);
        const now = checkedDate(this.clock(), "O relógio injetado retornou uma data inválida.");
        const today = civilDateAt(now, this.timeZone);
        const clock = parseClock(sourceText);
        const relative = parseRelativeOffset(normalized);
        const period = parseDayPeriod(normalized);
        const matches: string[] = [];

        if (relative) {
            matches.push(relative.matched);
            if (clock) {
                matches.push(clock.matched);
            }
            return this.resolveRelative(sourceText, normalized, now, today, relative, clock, period, matches);
        }

        const weekPhrase = matchText(normalized, /\b(?:semana que vem|proxima semana)\b/);
        const weekday = findWeekday(normalized);
        const explicitNextWeekday = Boolean(
            weekday && new RegExp(`\\bproxim[oa]\\s+${escapeRegExp(weekday.matched)}\\b`).test(normalized),
        );

        let date: CivilDate | undefined;
        let dateGranularity: "day" | "week" = "day";
        let explicitDate = false;

        const afterTomorrow = matchText(normalized, /\bdepois de amanha\b/);
        const tomorrow = afterTomorrow ? undefined : matchText(normalized, /\bamanha\b/);
        const todayMatch = matchText(normalized, /\bhoje\b/);

        if (afterTomorrow) {
            date = addCivilDays(today, 2);
            explicitDate = true;
            matches.push(afterTomorrow);
        } else if (tomorrow) {
            date = addCivilDays(today, 1);
            explicitDate = true;
            matches.push(tomorrow);
        } else if (todayMatch) {
            date = today;
            explicitDate = true;
            matches.push(todayMatch);
        } else if (weekPhrase && weekday) {
            const nextMonday = addCivilDays(today, daysUntilNextMonday(today));
            date = addCivilDays(nextMonday, weekday.index === 0 ? 6 : weekday.index - 1);
            explicitDate = true;
            matches.push(weekPhrase, weekday.matched);
        } else if (weekPhrase) {
            date = addCivilDays(today, daysUntilNextMonday(today));
            dateGranularity = "week";
            explicitDate = true;
            matches.push(weekPhrase);
        } else if (weekday) {
            const currentWeekday = weekdayOf(today);
            let daysAhead = (weekday.index - currentWeekday + 7) % 7;
            if (explicitNextWeekday && daysAhead === 0) {
                daysAhead = 7;
            }
            date = addCivilDays(today, daysAhead);
            explicitDate = true;
            matches.push(weekday.matched);
        }

        if (clock) {
            matches.push(clock.matched);
            date ??= today;
            let instant = zonedDateTimeToDate({ ...date, ...clock, second: 0, millisecond: 0 }, this.timeZone);

            const preferFuture = options.preferFuture ?? true;
            const dateCanRoll = !explicitDate || (weekday !== undefined && !weekPhrase && !explicitNextWeekday);
            if (preferFuture && dateCanRoll && instant.getTime() <= now.getTime()) {
                const days = weekday ? 7 : 1;
                date = addCivilDays(date, days);
                instant = zonedDateTimeToDate({ ...date, ...clock, second: 0, millisecond: 0 }, this.timeZone);
            }

            return instantResolution(sourceText, matches, this.timeZone, instant, "minute");
        }

        if (period) {
            matches.push(period.matched);
            date ??= today;
            const hours = this.periods[period.period];
            let range = periodRange(date, hours, this.timeZone);
            if (!explicitDate && (options.preferFuture ?? true) && range.endExclusive.getTime() <= now.getTime()) {
                date = addCivilDays(date, 1);
                range = periodRange(date, hours, this.timeZone);
            }
            return intervalResolution(sourceText, matches, this.timeZone, range, "day-period", false);
        }

        if (!date) {
            return null;
        }

        if (dateGranularity === "week") {
            const range = dateRange(date, addCivilDays(date, 7), this.timeZone);
            return intervalResolution(sourceText, matches, this.timeZone, range, "week", false);
        }

        return intervalResolution(
            sourceText,
            matches,
            this.timeZone,
            dateRange(date, addCivilDays(date, 1), this.timeZone),
            "day",
            true,
        );
    }

    private resolveRelative(
        sourceText: string,
        normalized: string,
        now: Date,
        today: CivilDate,
        relative: RelativeOffset,
        clock: ClockTime | undefined,
        period: { readonly period: DayPeriod; readonly matched: string } | undefined,
        matches: string[],
    ): TemporalResolution {
        if (relative.unit === "hour" && !clock && !period) {
            const instant = new Date(now.getTime() + relative.amount * 60 * 60 * 1_000);
            return instantResolution(sourceText, matches, this.timeZone, instant, "relative");
        }

        const targetDate = addCivilDays(today, relative.unit === "day" ? relative.amount : 0);

        if (clock) {
            const instant = zonedDateTimeToDate(
                { ...targetDate, ...clock, second: 0, millisecond: 0 },
                this.timeZone,
            );
            return instantResolution(sourceText, matches, this.timeZone, instant, "relative");
        }

        if (period) {
            matches.push(period.matched);
            return intervalResolution(
                sourceText,
                matches,
                this.timeZone,
                periodRange(targetDate, this.periods[period.period], this.timeZone),
                "day-period",
                false,
            );
        }

        if (relative.unit === "hour") {
            // Defensive fallback for a future extension that consumes a modifier.
            const instant = new Date(now.getTime() + relative.amount * 60 * 60 * 1_000);
            return instantResolution(sourceText, matches, this.timeZone, instant, "relative");
        }

        void normalized;
        return intervalResolution(
            sourceText,
            matches,
            this.timeZone,
            dateRange(targetDate, addCivilDays(targetDate, 1), this.timeZone),
            "day",
            true,
        );
    }
}

export function resolvePtBrTemporal(
    input: string,
    options: PtBrTemporalContextOptions & ResolveTemporalOptions = {},
): TemporalResolution | null {
    const { preferFuture, ...contextOptions } = options;
    return new PtBrTemporalContext(contextOptions).resolve(input, { preferFuture });
}

/** Chooses a provider-ready absolute timestamp from any resolution. */
export function temporalDueDate(
    resolution: TemporalResolution,
    strategy: "start" | "end" = "start",
): Date {
    if (resolution.instant) {
        return new Date(resolution.instant.getTime());
    }

    if (strategy === "end") {
        return new Date(resolution.range.endExclusive.getTime() - 1);
    }

    return new Date(resolution.range.start.getTime());
}

function instantResolution(
    sourceText: string,
    matchedText: readonly string[],
    timeZone: string,
    instant: Date,
    granularity: TemporalGranularity,
): TemporalResolution {
    const local = zonedParts(instant, timeZone);
    const endExclusive = new Date(instant.getTime() + 60_000);
    return {
        sourceText,
        matchedText: unique(matchesWithoutEmpty(matchedText)),
        timeZone,
        kind: "instant",
        granularity,
        allDay: false,
        instant: new Date(instant.getTime()),
        instantIso: instant.toISOString(),
        range: absoluteRange(instant, endExclusive),
        localDate: formatCivilDate(local),
        localTime: `${pad(local.hour)}:${pad(local.minute)}`,
    };
}

function intervalResolution(
    sourceText: string,
    matchedText: readonly string[],
    timeZone: string,
    range: { readonly start: Date; readonly endExclusive: Date },
    granularity: TemporalGranularity,
    allDay: boolean,
): TemporalResolution {
    const local = zonedParts(range.start, timeZone);
    return {
        sourceText,
        matchedText: unique(matchesWithoutEmpty(matchedText)),
        timeZone,
        kind: "interval",
        granularity,
        allDay,
        range: absoluteRange(range.start, range.endExclusive),
        localDate: formatCivilDate(local),
    };
}

function absoluteRange(start: Date, endExclusive: Date): AbsoluteTimeRange {
    return {
        start: new Date(start.getTime()),
        endExclusive: new Date(endExclusive.getTime()),
        startIso: start.toISOString(),
        endExclusiveIso: endExclusive.toISOString(),
    };
}

function parseRelativeOffset(normalized: string): RelativeOffset | undefined {
    const expression = new RegExp(
        `\\bdaqui(?:\\s+a)?\\s+(${NUMBER_PATTERN})\\s+(horas?|dias?)\\b`,
    );
    const match = expression.exec(normalized);
    if (!match?.[1] || !match[2]) {
        return undefined;
    }
    const amount = parsePtNumber(match[1]);
    if (amount === undefined || amount < 0) {
        return undefined;
    }
    return {
        amount,
        unit: match[2].startsWith("hora") ? "hour" : "day",
        matched: match[0],
    };
}

function parseClock(sourceText: string): ClockTime | undefined {
    const text = sourceText.toLocaleLowerCase("pt-BR");
    const prefixed = /\b(?:às|as)\s+([01]?\d|2[0-3])(?:\s*(?:h|horas?)(?:\s*([0-5]?\d))?|\s*[:h]\s*([0-5]\d))?\b/u.exec(text);
    const standalone = /\b([01]?\d|2[0-3])h(?:\s*([0-5]?\d))?\b/u.exec(text);
    const match = prefixed ?? standalone;
    if (!match?.[1]) {
        return undefined;
    }
    return {
        hour: Number(match[1]),
        minute: Number(match[2] ?? match[3] ?? 0),
        matched: match[0],
    };
}

function parseDayPeriod(normalized: string): { readonly period: DayPeriod; readonly matched: string } | undefined {
    const morning = matchText(normalized, /\b(?:de manha|pela manha|manha)\b/);
    if (morning) return { period: "morning", matched: morning };
    const afternoon = matchText(normalized, /\b(?:a tarde|de tarde|pela tarde|tarde)\b/);
    if (afternoon) return { period: "afternoon", matched: afternoon };
    const night = matchText(normalized, /\b(?:a noite|de noite|pela noite|noite)\b/);
    if (night) return { period: "night", matched: night };
    return undefined;
}

function findWeekday(normalized: string): { readonly index: number; readonly matched: string } | undefined {
    for (const weekday of WEEKDAYS) {
        const matched = matchText(normalized, weekday.pattern);
        if (matched) return { index: weekday.index, matched };
    }
    return undefined;
}

function parsePtNumber(value: string): number | undefined {
    if (/^\d+$/.test(value)) {
        return Number(value);
    }
    const normalized = normalize(value);
    const direct = SIMPLE_NUMBERS[normalized];
    if (direct !== undefined) return direct;
    const compound = /^(vinte)\s+e\s+(\w+)$/.exec(normalized);
    if (!compound?.[2]) return undefined;
    const units = SIMPLE_NUMBERS[compound[2]];
    return units === undefined ? undefined : 20 + units;
}

function periodRange(
    date: CivilDate,
    hours: readonly [number, number],
    timeZone: string,
): { readonly start: Date; readonly endExclusive: Date } {
    const start = zonedDateTimeToDate({ ...date, hour: hours[0], minute: 0, second: 0, millisecond: 0 }, timeZone);
    const endDate = hours[1] === 24 ? addCivilDays(date, 1) : date;
    const endHour = hours[1] === 24 ? 0 : hours[1];
    const endExclusive = zonedDateTimeToDate(
        { ...endDate, hour: endHour, minute: 0, second: 0, millisecond: 0 },
        timeZone,
    );
    return { start, endExclusive };
}

function dateRange(
    startDate: CivilDate,
    endDate: CivilDate,
    timeZone: string,
): { readonly start: Date; readonly endExclusive: Date } {
    return {
        start: zonedDateTimeToDate({ ...startDate, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone),
        endExclusive: zonedDateTimeToDate({ ...endDate, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone),
    };
}

function civilDateAt(date: Date, timeZone: string): CivilDate {
    const parts = zonedParts(date, timeZone);
    return { year: parts.year, month: parts.month, day: parts.day };
}

function zonedParts(date: Date, timeZone: string): CivilDateTime {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    return {
        year: Number(values.get("year")),
        month: Number(values.get("month")),
        day: Number(values.get("day")),
        hour: Number(values.get("hour")),
        minute: Number(values.get("minute")),
        second: Number(values.get("second")),
        millisecond: date.getUTCMilliseconds(),
    };
}

/** Converts a civil wall-clock value in an IANA timezone to an absolute Date. */
function zonedDateTimeToDate(value: CivilDateTime, timeZone: string): Date {
    const targetAsUtc = Date.UTC(
        value.year,
        value.month - 1,
        value.day,
        value.hour,
        value.minute,
        value.second,
        value.millisecond,
    );
    let candidate = targetAsUtc;

    // Iteration also handles zones whose offset changes close to the target.
    for (let iteration = 0; iteration < 4; iteration += 1) {
        const actual = zonedParts(new Date(candidate), timeZone);
        const actualAsUtc = Date.UTC(
            actual.year,
            actual.month - 1,
            actual.day,
            actual.hour,
            actual.minute,
            actual.second,
            value.millisecond,
        );
        const adjustment = targetAsUtc - actualAsUtc;
        if (adjustment === 0) break;
        candidate += adjustment;
    }

    return checkedDate(new Date(candidate), "Não foi possível resolver a data no timezone solicitado.");
}

function addCivilDays(date: CivilDate, amount: number): CivilDate {
    const value = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
    return {
        year: value.getUTCFullYear(),
        month: value.getUTCMonth() + 1,
        day: value.getUTCDate(),
    };
}

function weekdayOf(date: CivilDate): number {
    return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function daysUntilNextMonday(date: CivilDate): number {
    const current = weekdayOf(date);
    const days = (1 - current + 7) % 7;
    return days === 0 ? 7 : days;
}

function normalize(value: string): string {
    return value
        .toLocaleLowerCase("pt-BR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
}

function matchText(value: string, pattern: RegExp): string | undefined {
    return pattern.exec(value)?.[0];
}

function formatCivilDate(date: CivilDate): string {
    return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

function checkedDate(date: Date, message: string): Date {
    if (!Number.isFinite(date.getTime())) {
        throw new TypeError(message);
    }
    return new Date(date.getTime());
}

function assertValidTimeZone(timeZone: string): void {
    try {
        new Intl.DateTimeFormat("pt-BR", { timeZone }).format(new Date(0));
    } catch {
        throw new RangeError(`Timezone IANA inválido: ${timeZone}`);
    }
}

function validatePeriods(periods: Record<DayPeriod, readonly [number, number]>): void {
    for (const [name, [start, end]] of Object.entries(periods)) {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end <= start || end > 24) {
            throw new RangeError(`Período ${name} inválido: esperado [início, fim] entre 0 e 24.`);
        }
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesWithoutEmpty(values: readonly string[]): string[] {
    return values.filter((value) => value.length > 0);
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}
