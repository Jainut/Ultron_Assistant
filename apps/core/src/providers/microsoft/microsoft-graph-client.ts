import type { FetchTransport } from "../../security/oauth2-desktop.ts";
import {
    OAuthApiClient,
    type AccessTokenSource,
    type OAuthApiClientOptions,
} from "../oauth-api-client.ts";
import { providerDateTime, type ProviderDateTime } from "../types.ts";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0/";

export interface MicrosoftGraphDateTime {
    readonly dateTime?: string;
    readonly timeZone?: string;
}

export class MicrosoftGraphClient extends OAuthApiClient {
    constructor(
        providerId: string,
        oauth: AccessTokenSource,
        transport: FetchTransport = globalThis.fetch,
        options: OAuthApiClientOptions = {},
    ) {
        super(providerId, GRAPH_BASE_URL, oauth, transport, options);
    }
}

/** Graph accepts absolute instants in UTC; all-day values stay at local midnight. */
export function serializeMicrosoftDateTime(value: ProviderDateTime): MicrosoftGraphDateTime {
    if (value.allDay) {
        const parts = zonedParts(value.date, value.timeZone);
        return {
            dateTime: `${four(parts.year)}-${two(parts.month)}-${two(parts.day)}T00:00:00.000`,
            timeZone: value.timeZone,
        };
    }
    return {
        dateTime: value.date.toISOString().replace(/Z$/, ""),
        timeZone: "UTC",
    };
}

/**
 * Responses are requested in UTC. Offset-bearing and IANA responses are also
 * accepted so existing data remains readable if Graph ignores the preference.
 */
export function parseMicrosoftDateTime(
    value: MicrosoftGraphDateTime | undefined,
    displayTimeZone: string,
    allDay = false,
): ProviderDateTime | undefined {
    const raw = value?.dateTime?.trim();
    if (!raw) return undefined;
    const normalized = normalizeFraction(raw);
    if (allDay) {
        const dateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(normalized)?.[1];
        if (!dateOnly) return undefined;
        const localMidnight = parseIanaWallTime(`${dateOnly}T00:00:00.000`, displayTimeZone);
        return Number.isFinite(localMidnight.getTime())
            ? providerDateTime(localMidnight, displayTimeZone, true)
            : undefined;
    }
    let date: Date;

    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
        date = new Date(normalized);
    } else if (!value?.timeZone || /^(?:UTC|GMT)$/i.test(value.timeZone)) {
        date = new Date(`${normalized}Z`);
    } else {
        date = parseIanaWallTime(normalized, value.timeZone);
    }
    if (!Number.isFinite(date.getTime())) return undefined;
    return providerDateTime(date, displayTimeZone, allDay);
}

export function isMicrosoftNextLink(value: string | undefined): value is string {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.origin === "https://graph.microsoft.com"
            && url.pathname.startsWith("/v1.0/");
    } catch {
        return false;
    }
}

function normalizeFraction(value: string): string {
    return value.replace(/(\.\d{3})\d+/, "$1");
}

function parseIanaWallTime(value: string, timeZone: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
    if (!match) return new Date(Number.NaN);
    try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format();
    } catch {
        return new Date(Number.NaN);
    }
    const target = {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6]),
        millisecond: Number((match[7] ?? "0").padEnd(3, "0")),
    };
    const targetAsUtc = Date.UTC(
        target.year,
        target.month - 1,
        target.day,
        target.hour,
        target.minute,
        target.second,
        target.millisecond,
    );
    let candidate = targetAsUtc;
    for (let iteration = 0; iteration < 4; iteration += 1) {
        const actual = zonedParts(new Date(candidate), timeZone);
        const actualAsUtc = Date.UTC(
            actual.year,
            actual.month - 1,
            actual.day,
            actual.hour,
            actual.minute,
            actual.second,
            target.millisecond,
        );
        const adjustment = targetAsUtc - actualAsUtc;
        if (adjustment === 0) break;
        candidate += adjustment;
    }
    return new Date(candidate);
}

function zonedParts(date: Date, timeZone: string): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
} {
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
    const values = new Map(parts.map(part => [part.type, part.value]));
    return {
        year: Number(values.get("year")),
        month: Number(values.get("month")),
        day: Number(values.get("day")),
        hour: Number(values.get("hour")),
        minute: Number(values.get("minute")),
        second: Number(values.get("second")),
    };
}

function two(value: number): string {
    return String(value).padStart(2, "0");
}

function four(value: number): string {
    return String(value).padStart(4, "0");
}
