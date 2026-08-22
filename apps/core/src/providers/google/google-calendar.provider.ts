import type { FetchTransport } from "../../security/oauth2-desktop.ts";
import type {
    CalendarEvent,
    CalendarProvider,
    CreateCalendarEventInput,
    ListCalendarEventsOptions,
    SearchCalendarEventsOptions,
    UpdateCalendarEventInput,
} from "../calendar-provider.ts";
import {
    ProviderConflictError,
    ProviderValidationError,
    requireUserConfirmation,
    type ProviderHealth,
    type ProviderRequestContext,
    type UserConfirmation,
} from "../provider.ts";
import {
    providerDateTime,
    untrustedText,
    type Page,
    type ProviderDateTime,
} from "../types.ts";
import {
    GoogleApiClient,
    type AccessTokenSource,
} from "./google-api-client.ts";

const PROVIDER_ID = "google.calendar";
const CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3/";

interface GoogleEventDateTime {
    date?: string;
    dateTime?: string;
    timeZone?: string;
}

interface GoogleCalendarEventResource {
    id?: string;
    status?: string;
    summary?: string;
    description?: string;
    location?: string;
    start?: GoogleEventDateTime;
    end?: GoogleEventDateTime;
    attendees?: Array<{
        email?: string;
        displayName?: string;
        responseStatus?: string;
    }>;
    htmlLink?: string;
    recurringEventId?: string;
    transparency?: string;
}

interface GoogleCalendarEventsResource {
    items?: GoogleCalendarEventResource[];
    nextPageToken?: string;
}

export interface GoogleCalendarProviderOptions {
    readonly oauth: AccessTokenSource;
    readonly transport?: FetchTransport;
    readonly defaultCalendarId?: string;
    readonly timeZone?: string;
}

export class GoogleCalendarProvider implements CalendarProvider {
    readonly id = PROVIDER_ID;
    readonly kind = "calendar" as const;
    readonly displayName = "Google Calendar";

    private readonly api: GoogleApiClient;
    private readonly defaultCalendarId: string;
    private readonly timeZone: string;

    constructor(options: GoogleCalendarProviderOptions) {
        this.api = new GoogleApiClient(
            this.id,
            CALENDAR_BASE_URL,
            options.oauth,
            options.transport,
        );
        this.defaultCalendarId = options.defaultCalendarId?.trim() || "primary";
        this.timeZone = options.timeZone?.trim()
            || Intl.DateTimeFormat().resolvedOptions().timeZone
            || "UTC";
    }

    async healthCheck(context?: ProviderRequestContext): Promise<ProviderHealth> {
        await this.api.request(
            `calendars/${encodeURIComponent(this.defaultCalendarId)}`,
            { signal: context?.signal },
        );
        return { providerId: this.id, status: "ready", checkedAt: new Date() };
    }

    async listEvents(options: ListCalendarEventsOptions): Promise<Page<CalendarEvent>> {
        validateRange(options.timeMin, options.timeMax);
        const calendarId = this.calendarId(options.calendarId);
        const resource = await this.listEventResources(calendarId, {
            timeMin: options.timeMin,
            timeMax: options.timeMax,
            maxResults: options.maxResults,
            pageToken: options.pageToken,
            includeCancelled: options.includeCancelled,
            signal: options.signal,
        });
        return {
            items: (resource.items ?? []).map(event => this.parseEvent(event, calendarId)),
            nextPageToken: resource.nextPageToken,
        };
    }

    async searchEvents(options: SearchCalendarEventsOptions): Promise<Page<CalendarEvent>> {
        if (!options.query.trim()) {
            throw new ProviderValidationError(this.id, "A busca do calendário não pode ser vazia.");
        }
        validateRange(options.timeMin, options.timeMax);
        const calendarId = this.calendarId(options.calendarId);
        const resource = await this.listEventResources(calendarId, {
            timeMin: options.timeMin,
            timeMax: options.timeMax,
            maxResults: options.maxResults,
            pageToken: options.pageToken,
            includeCancelled: options.includeCancelled,
            query: options.query,
            signal: options.signal,
        });
        return {
            items: (resource.items ?? []).map(event => this.parseEvent(event, calendarId)),
            nextPageToken: resource.nextPageToken,
        };
    }

    async findConflicts(
        start: ProviderDateTime,
        end: ProviderDateTime,
        calendarId?: string,
        context?: ProviderRequestContext,
        excludeEventId?: string,
    ): Promise<readonly CalendarEvent[]> {
        validateRange(start, end);
        const resolvedCalendarId = this.calendarId(calendarId);
        const resource = await this.listEventResources(resolvedCalendarId, {
            timeMin: start,
            timeMax: end,
            maxResults: 250,
            includeCancelled: false,
            signal: context?.signal,
        });
        return (resource.items ?? [])
            .filter(event => event.id !== excludeEventId)
            .filter(event => event.status !== "cancelled")
            .filter(event => event.transparency !== "transparent")
            .map(event => this.parseEvent(event, resolvedCalendarId))
            .filter(event => overlaps(event.start.date, event.end.date, start.date, end.date));
    }

    async createEvent(
        input: CreateCalendarEventInput,
        context?: ProviderRequestContext,
    ): Promise<CalendarEvent> {
        this.validateEventInput(input);
        const calendarId = this.calendarId(input.calendarId);
        if (input.checkConflicts !== false && !input.allowConflicts) {
            const conflicts = await this.findConflicts(
                input.start,
                input.end,
                calendarId,
                context,
            );
            if (conflicts.length > 0) {
                throw new ProviderConflictError(
                    this.id,
                    "O evento conflita com um compromisso existente.",
                    conflicts,
                );
            }
        }

        const resource = await this.api.request<GoogleCalendarEventResource>(
            `calendars/${encodeURIComponent(calendarId)}/events`,
            {
                method: "POST",
                body: this.eventWriteBody(input),
                signal: context?.signal,
            },
        );
        return this.parseEvent(resource, calendarId);
    }

    async updateEvent(
        eventId: string,
        input: UpdateCalendarEventInput,
        context?: ProviderRequestContext,
    ): Promise<CalendarEvent> {
        this.validateEventId(eventId);
        const calendarId = this.calendarId(input.calendarId);
        let effectiveStart = input.start;
        let effectiveEnd = input.end;

        if (input.start || input.end) {
            const current = await this.getEventResource(eventId, calendarId, context);
            effectiveStart ??= parseGoogleDateTime(current.start, this.timeZone);
            effectiveEnd ??= parseGoogleDateTime(current.end, this.timeZone);
            if (!effectiveStart || !effectiveEnd) {
                throw new ProviderValidationError(this.id, "O evento atual não possui intervalo válido.");
            }
            validateRange(effectiveStart, effectiveEnd);

            if (input.checkConflicts !== false && !input.allowConflicts) {
                const conflicts = await this.findConflicts(
                    effectiveStart,
                    effectiveEnd,
                    calendarId,
                    context,
                    eventId,
                );
                if (conflicts.length > 0) {
                    throw new ProviderConflictError(
                        this.id,
                        "A alteração conflita com um compromisso existente.",
                        conflicts,
                    );
                }
            }
        }

        const body: Record<string, unknown> = {};
        if (input.summary !== undefined) {
            if (!input.summary.trim()) {
                throw new ProviderValidationError(this.id, "Título do evento é obrigatório.");
            }
            body.summary = input.summary;
        }
        if (input.description !== undefined) body.description = input.description;
        if (input.location !== undefined) body.location = input.location;
        if (input.start) body.start = serializeEventDateTime(input.start);
        if (input.end) body.end = serializeEventDateTime(input.end);
        if (input.attendees) {
            validateAttendees(input.attendees);
            body.attendees = input.attendees.map(email => ({ email }));
        }

        const resource = await this.api.request<GoogleCalendarEventResource>(
            `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
            {
                method: "PATCH",
                body,
                signal: context?.signal,
            },
        );
        return this.parseEvent(resource, calendarId);
    }

    async cancelEvent(
        eventId: string,
        confirmation: UserConfirmation,
        calendarId?: string,
        context?: ProviderRequestContext,
    ): Promise<void> {
        requireUserConfirmation(this.id, confirmation, "calendar.cancel");
        this.validateEventId(eventId);
        await this.api.request(
            `calendars/${encodeURIComponent(this.calendarId(calendarId))}/events/${encodeURIComponent(eventId)}`,
            { method: "DELETE", signal: context?.signal },
        );
    }

    private async listEventResources(
        calendarId: string,
        options: {
            readonly timeMin: ProviderDateTime;
            readonly timeMax: ProviderDateTime;
            readonly maxResults?: number;
            readonly pageToken?: string;
            readonly includeCancelled?: boolean;
            readonly query?: string;
            readonly signal?: AbortSignal;
        },
    ): Promise<GoogleCalendarEventsResource> {
        return await this.api.request<GoogleCalendarEventsResource>(
            `calendars/${encodeURIComponent(calendarId)}/events`,
            {
                query: {
                    timeMin: options.timeMin.iso,
                    timeMax: options.timeMax.iso,
                    maxResults: clamp(options.maxResults ?? 50, 1, 250),
                    pageToken: options.pageToken,
                    showDeleted: options.includeCancelled ?? false,
                    singleEvents: true,
                    orderBy: "startTime",
                    timeZone: this.timeZone,
                    q: options.query,
                },
                signal: options.signal,
            },
        );
    }

    private async getEventResource(
        eventId: string,
        calendarId: string,
        context?: ProviderRequestContext,
    ): Promise<GoogleCalendarEventResource> {
        return await this.api.request<GoogleCalendarEventResource>(
            `calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
            { signal: context?.signal },
        );
    }

    private parseEvent(
        resource: GoogleCalendarEventResource,
        calendarId: string,
    ): CalendarEvent {
        const id = resource.id ?? "unknown";
        const start = parseGoogleDateTime(resource.start, this.timeZone);
        const end = parseGoogleDateTime(resource.end, this.timeZone);
        if (!start || !end) {
            throw new ProviderValidationError(this.id, "Evento remoto sem intervalo válido.");
        }

        const knownStatus = resource.status === "confirmed"
            || resource.status === "tentative"
            || resource.status === "cancelled"
            ? resource.status
            : "unknown";
        return {
            id,
            calendarId,
            summary: untrustedText(resource.summary, this.id, id, "summary"),
            ...(resource.description !== undefined
                ? { description: untrustedText(resource.description, this.id, id, "description") }
                : {}),
            ...(resource.location !== undefined
                ? { location: untrustedText(resource.location, this.id, id, "location") }
                : {}),
            start,
            end,
            status: knownStatus,
            attendees: (resource.attendees ?? []).map((attendee, index) => ({
                email: untrustedText(attendee.email, this.id, id, `attendees.${index}.email`),
                ...(attendee.displayName !== undefined
                    ? {
                        displayName: untrustedText(
                            attendee.displayName,
                            this.id,
                            id,
                            `attendees.${index}.displayName`,
                        ),
                    }
                    : {}),
                responseStatus: attendee.responseStatus,
            })),
            ...(resource.htmlLink !== undefined
                ? { htmlLink: untrustedText(resource.htmlLink, this.id, id, "htmlLink") }
                : {}),
            recurringEventId: resource.recurringEventId,
        };
    }

    private eventWriteBody(input: CreateCalendarEventInput): Record<string, unknown> {
        return {
            summary: input.summary,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
            start: serializeEventDateTime(input.start),
            end: serializeEventDateTime(input.end),
            ...(input.attendees
                ? { attendees: input.attendees.map(email => ({ email })) }
                : {}),
        };
    }

    private validateEventInput(input: CreateCalendarEventInput): void {
        if (!input.summary.trim()) {
            throw new ProviderValidationError(this.id, "Título do evento é obrigatório.");
        }
        validateRange(input.start, input.end);
        if (input.start.allDay !== input.end.allDay) {
            throw new ProviderValidationError(
                this.id,
                "Início e fim precisam usar o mesmo modo de data.",
            );
        }
        validateAttendees(input.attendees ?? []);
    }

    private calendarId(value: string | undefined): string {
        return value?.trim() || this.defaultCalendarId;
    }

    private validateEventId(value: string): void {
        if (!value.trim()) {
            throw new ProviderValidationError(this.id, "ID do evento é obrigatório.");
        }
    }
}

function serializeEventDateTime(value: ProviderDateTime): GoogleEventDateTime {
    if (value.allDay) {
        return { date: value.iso.slice(0, 10) };
    }
    return { dateTime: value.iso, timeZone: value.timeZone };
}

function parseGoogleDateTime(
    value: GoogleEventDateTime | undefined,
    fallbackTimeZone: string,
): ProviderDateTime | undefined {
    if (value?.dateTime) {
        const date = new Date(value.dateTime);
        if (!Number.isFinite(date.getTime())) return undefined;
        return providerDateTime(date, value.timeZone || fallbackTimeZone);
    }
    if (value?.date) {
        const date = new Date(`${value.date}T00:00:00.000Z`);
        if (!Number.isFinite(date.getTime())) return undefined;
        return providerDateTime(date, value.timeZone || fallbackTimeZone, true);
    }
    return undefined;
}

function validateRange(start: ProviderDateTime, end: ProviderDateTime): void {
    if (start.date.getTime() >= end.date.getTime()) {
        throw new ProviderValidationError(
            PROVIDER_ID,
            "O fim do evento precisa ocorrer depois do início.",
        );
    }
}

function validateAttendees(attendees: readonly string[]): void {
    for (const email of attendees) {
        if (!email.trim() || /[\r\n]/.test(email)) {
            throw new ProviderValidationError(PROVIDER_ID, "Participante inválido.");
        }
    }
}

function overlaps(
    firstStart: Date,
    firstEnd: Date,
    secondStart: Date,
    secondEnd: Date,
): boolean {
    return firstStart.getTime() < secondEnd.getTime()
        && firstEnd.getTime() > secondStart.getTime();
}

function clamp(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) return minimum;
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
