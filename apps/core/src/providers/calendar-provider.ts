import type {
    ProviderIdentity,
    ProviderRequestContext,
    UserConfirmation,
} from "./provider.ts";
import type {
    Page,
    ProviderDateTime,
    UntrustedExternalText,
} from "./types.ts";

export interface CalendarAttendee {
    readonly email: UntrustedExternalText;
    readonly displayName?: UntrustedExternalText;
    readonly responseStatus?: string;
}

export interface CalendarEvent {
    readonly id: string;
    readonly calendarId: string;
    readonly summary: UntrustedExternalText;
    readonly description?: UntrustedExternalText;
    readonly location?: UntrustedExternalText;
    readonly start: ProviderDateTime;
    readonly end: ProviderDateTime;
    readonly status: "confirmed" | "tentative" | "cancelled" | "unknown";
    readonly attendees: readonly CalendarAttendee[];
    readonly htmlLink?: UntrustedExternalText;
    readonly recurringEventId?: string;
}

export interface ListCalendarEventsOptions extends ProviderRequestContext {
    readonly calendarId?: string;
    readonly timeMin: ProviderDateTime;
    readonly timeMax: ProviderDateTime;
    readonly maxResults?: number;
    readonly pageToken?: string;
    readonly includeCancelled?: boolean;
}

export interface SearchCalendarEventsOptions extends ListCalendarEventsOptions {
    readonly query: string;
}

export interface CreateCalendarEventInput {
    readonly calendarId?: string;
    readonly summary: string;
    readonly description?: string;
    readonly location?: string;
    readonly start: ProviderDateTime;
    readonly end: ProviderDateTime;
    readonly attendees?: readonly string[];
    /** Defaults to true; set allowConflicts only after an explicit decision. */
    readonly checkConflicts?: boolean;
    readonly allowConflicts?: boolean;
}

export interface UpdateCalendarEventInput {
    readonly calendarId?: string;
    readonly summary?: string;
    readonly description?: string | null;
    readonly location?: string | null;
    readonly start?: ProviderDateTime;
    readonly end?: ProviderDateTime;
    readonly attendees?: readonly string[];
    readonly checkConflicts?: boolean;
    readonly allowConflicts?: boolean;
}

export interface CalendarProvider extends ProviderIdentity {
    readonly kind: "calendar";

    listEvents(options: ListCalendarEventsOptions): Promise<Page<CalendarEvent>>;
    searchEvents(options: SearchCalendarEventsOptions): Promise<Page<CalendarEvent>>;
    findConflicts(
        start: ProviderDateTime,
        end: ProviderDateTime,
        calendarId?: string,
        context?: ProviderRequestContext,
        excludeEventId?: string,
    ): Promise<readonly CalendarEvent[]>;
    createEvent(
        input: CreateCalendarEventInput,
        context?: ProviderRequestContext,
    ): Promise<CalendarEvent>;
    updateEvent(
        eventId: string,
        input: UpdateCalendarEventInput,
        context?: ProviderRequestContext,
    ): Promise<CalendarEvent>;
    cancelEvent(
        eventId: string,
        confirmation: UserConfirmation,
        calendarId?: string,
        context?: ProviderRequestContext,
    ): Promise<void>;
}
