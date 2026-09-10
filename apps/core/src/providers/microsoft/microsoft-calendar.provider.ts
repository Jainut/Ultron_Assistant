import type { FetchTransport } from "../../security/oauth2-desktop.ts";
import type {
    CalendarEvent,
    CalendarProvider,
    CreateCalendarEventInput,
    ListCalendarEventsOptions,
    SearchCalendarEventsOptions,
    UpdateCalendarEventInput,
} from "../calendar-provider.ts";
import type { AccessTokenSource } from "../oauth-api-client.ts";
import {
    ProviderConflictError,
    ProviderValidationError,
    requireUserConfirmation,
    type ProviderHealth,
    type ProviderRequestContext,
    type UserConfirmation,
} from "../provider.ts";
import {
    untrustedText,
    type Page,
    type ProviderDateTime,
} from "../types.ts";
import {
    isMicrosoftNextLink,
    MicrosoftGraphClient,
    parseMicrosoftDateTime,
    serializeMicrosoftDateTime,
    type MicrosoftGraphDateTime,
} from "./microsoft-graph-client.ts";

const PROVIDER_ID = "microsoft.calendar";
const DEFAULT_CALENDAR_SENTINELS = new Set(["", "primary", "default", "@default"]);

interface GraphCollection<T> {
    readonly value?: T[];
    readonly "@odata.nextLink"?: string;
}

interface MicrosoftCalendarEventResource {
    readonly id?: string;
    readonly subject?: string;
    readonly body?: {
        readonly content?: string;
        readonly contentType?: string;
    };
    readonly location?: { readonly displayName?: string };
    readonly start?: MicrosoftGraphDateTime;
    readonly end?: MicrosoftGraphDateTime;
    readonly isAllDay?: boolean;
    readonly isCancelled?: boolean;
    readonly showAs?: string;
    readonly attendees?: Array<{
        readonly emailAddress?: {
            readonly address?: string;
            readonly name?: string;
        };
        readonly status?: { readonly response?: string };
    }>;
    readonly webLink?: string;
    readonly seriesMasterId?: string;
}

export interface MicrosoftCalendarProviderOptions {
    readonly oauth: AccessTokenSource;
    readonly transport?: FetchTransport;
    readonly defaultCalendarId?: string;
    readonly timeZone?: string;
}

export class MicrosoftCalendarProvider implements CalendarProvider {
    readonly id = PROVIDER_ID;
    readonly kind = "calendar" as const;
    readonly displayName = "Outlook Calendar";

    private readonly api: MicrosoftGraphClient;
    private readonly defaultCalendarId: string;
    private readonly timeZone: string;

    constructor(options: MicrosoftCalendarProviderOptions) {
        this.api = new MicrosoftGraphClient(
            this.id,
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
            this.isDefaultCalendar(this.defaultCalendarId)
                ? "me/calendar"
                : `me/calendars/${encodeURIComponent(this.defaultCalendarId)}`,
            { signal: context?.signal },
        );
        return { providerId: this.id, status: "ready", checkedAt: new Date() };
    }

    async listEvents(options: ListCalendarEventsOptions): Promise<Page<CalendarEvent>> {
        validateRange(options.timeMin, options.timeMax);
        const calendarId = this.calendarId(options.calendarId);
        const resource = await this.listEventResources(calendarId, options);
        const items = (resource.value ?? [])
            .filter(event => options.includeCancelled || !event.isCancelled)
            .map(event => this.parseEvent(event, calendarId));
        const nextLink = resource["@odata.nextLink"];
        return {
            items,
            ...(isMicrosoftNextLink(nextLink) ? { nextPageToken: nextLink } : {}),
        };
    }

    async searchEvents(options: SearchCalendarEventsOptions): Promise<Page<CalendarEvent>> {
        const query = normalize(options.query);
        if (!query) {
            throw new ProviderValidationError(this.id, "A busca do calendário não pode ser vazia.");
        }
        const requestedLimit = clamp(options.maxResults ?? 50, 1, 100);
        const page = await this.listEvents({
            ...options,
            maxResults: Math.max(requestedLimit, 100),
        });
        return {
            items: page.items.filter(event => [
                event.summary.value,
                event.description?.value ?? "",
                event.location?.value ?? "",
            ].some(value => normalize(value).includes(query))).slice(0, requestedLimit),
            nextPageToken: page.nextPageToken,
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
        return (resource.value ?? [])
            .filter(event => event.id !== excludeEventId)
            .filter(event => !event.isCancelled && event.showAs !== "free")
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

        const resource = await this.api.request<MicrosoftCalendarEventResource>(
            this.eventsPath(calendarId),
            {
                method: "POST",
                body: this.eventWriteBody(input),
                headers: graphTimeZoneHeaders(),
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
            const current = await this.getEventResource(eventId, calendarId, context?.signal);
            effectiveStart ??= parseMicrosoftDateTime(current.start, this.timeZone, current.isAllDay);
            effectiveEnd ??= parseMicrosoftDateTime(current.end, this.timeZone, current.isAllDay);
            if (!effectiveStart || !effectiveEnd) {
                throw new ProviderValidationError(this.id, "O evento atual não possui intervalo válido.");
            }
            validateRange(effectiveStart, effectiveEnd);
            validateAllDayCompatibility(effectiveStart, effectiveEnd);
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
            body.subject = input.summary;
        }
        if (input.description !== undefined) {
            body.body = input.description === null
                ? { content: "", contentType: "text" }
                : { content: input.description, contentType: "text" };
        }
        if (input.location !== undefined) {
            body.location = input.location === null
                ? { displayName: "" }
                : { displayName: input.location };
        }
        if (input.start) body.start = serializeMicrosoftDateTime(input.start);
        if (input.end) body.end = serializeMicrosoftDateTime(input.end);
        if (input.start || input.end) {
            body.isAllDay = Boolean((input.start ?? effectiveStart)?.allDay);
        }
        if (input.attendees) {
            validateAttendees(input.attendees);
            body.attendees = serializeAttendees(input.attendees);
        }

        const resource = Object.keys(body).length > 0
            ? await this.api.request<MicrosoftCalendarEventResource>(
                this.eventPath(calendarId, eventId),
                {
                    method: "PATCH",
                    body,
                    headers: graphTimeZoneHeaders(),
                    signal: context?.signal,
                },
            )
            : await this.getEventResource(eventId, calendarId, context?.signal);
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
        await this.api.request(this.eventPath(this.calendarId(calendarId), eventId), {
            method: "DELETE",
            signal: context?.signal,
        });
    }

    private async listEventResources(
        calendarId: string,
        options: {
            readonly timeMin: ProviderDateTime;
            readonly timeMax: ProviderDateTime;
            readonly maxResults?: number;
            readonly pageToken?: string;
            readonly includeCancelled?: boolean;
            readonly signal?: AbortSignal;
        },
    ): Promise<GraphCollection<MicrosoftCalendarEventResource>> {
        const fallback = this.isDefaultCalendar(calendarId)
            ? "me/calendar/calendarView"
            : `me/calendars/${encodeURIComponent(calendarId)}/calendarView`;
        const path = pagePath(options.pageToken, fallback);
        return await this.api.request(path, {
            query: options.pageToken ? undefined : {
                startDateTime: options.timeMin.iso,
                endDateTime: options.timeMax.iso,
                "$top": clamp(options.maxResults ?? 50, 1, 1_000),
                "$orderby": "start/dateTime",
            },
            headers: graphTimeZoneHeaders(),
            signal: options.signal,
        });
    }

    private async getEventResource(
        eventId: string,
        calendarId: string,
        signal?: AbortSignal,
    ): Promise<MicrosoftCalendarEventResource> {
        return await this.api.request(this.eventPath(calendarId, eventId), {
            headers: graphTimeZoneHeaders(),
            signal,
        });
    }

    private parseEvent(
        resource: MicrosoftCalendarEventResource,
        calendarId: string,
    ): CalendarEvent {
        const id = resource.id ?? "unknown";
        const start = parseMicrosoftDateTime(resource.start, this.timeZone, resource.isAllDay);
        const end = parseMicrosoftDateTime(resource.end, this.timeZone, resource.isAllDay);
        if (!start || !end) {
            throw new ProviderValidationError(this.id, "Evento remoto sem intervalo válido.");
        }
        const status = resource.isCancelled
            ? "cancelled"
            : resource.showAs === "tentative"
                ? "tentative"
                : "confirmed";
        return {
            id,
            calendarId,
            summary: untrustedText(resource.subject, this.id, id, "subject"),
            ...(resource.body?.content !== undefined
                ? {
                    description: untrustedText(
                        resource.body.content,
                        this.id,
                        id,
                        "body.content",
                    ),
                }
                : {}),
            ...(resource.location?.displayName !== undefined
                ? {
                    location: untrustedText(
                        resource.location.displayName,
                        this.id,
                        id,
                        "location.displayName",
                    ),
                }
                : {}),
            start,
            end,
            status,
            attendees: (resource.attendees ?? []).map((attendee, index) => ({
                email: untrustedText(
                    attendee.emailAddress?.address,
                    this.id,
                    id,
                    `attendees.${index}.emailAddress.address`,
                ),
                ...(attendee.emailAddress?.name !== undefined
                    ? {
                        displayName: untrustedText(
                            attendee.emailAddress.name,
                            this.id,
                            id,
                            `attendees.${index}.emailAddress.name`,
                        ),
                    }
                    : {}),
                responseStatus: attendee.status?.response,
            })),
            ...(resource.webLink !== undefined
                ? { htmlLink: untrustedText(resource.webLink, this.id, id, "webLink") }
                : {}),
            recurringEventId: resource.seriesMasterId,
        };
    }

    private eventWriteBody(input: CreateCalendarEventInput): Record<string, unknown> {
        return {
            subject: input.summary,
            ...(input.description !== undefined
                ? { body: { content: input.description, contentType: "text" } }
                : {}),
            ...(input.location !== undefined
                ? { location: { displayName: input.location } }
                : {}),
            start: serializeMicrosoftDateTime(input.start),
            end: serializeMicrosoftDateTime(input.end),
            isAllDay: Boolean(input.start.allDay),
            ...(input.attendees ? { attendees: serializeAttendees(input.attendees) } : {}),
        };
    }

    private eventsPath(calendarId: string): string {
        return this.isDefaultCalendar(calendarId)
            ? "me/calendar/events"
            : `me/calendars/${encodeURIComponent(calendarId)}/events`;
    }

    private eventPath(calendarId: string, eventId: string): string {
        return `${this.eventsPath(calendarId)}/${encodeURIComponent(eventId)}`;
    }

    private calendarId(value: string | undefined): string {
        return value?.trim() || this.defaultCalendarId;
    }

    private isDefaultCalendar(value: string): boolean {
        return DEFAULT_CALENDAR_SENTINELS.has(value.toLowerCase());
    }

    private validateEventInput(input: CreateCalendarEventInput): void {
        if (!input.summary.trim()) {
            throw new ProviderValidationError(this.id, "Título do evento é obrigatório.");
        }
        validateRange(input.start, input.end);
        validateAllDayCompatibility(input.start, input.end);
        validateAttendees(input.attendees ?? []);
    }

    private validateEventId(value: string): void {
        if (!value.trim()) {
            throw new ProviderValidationError(this.id, "ID do evento é obrigatório.");
        }
    }
}

function graphTimeZoneHeaders(): Record<string, string> {
    return { Prefer: 'outlook.timezone="UTC"' };
}

function pagePath(token: string | undefined, fallback: string): string {
    if (!token) return fallback;
    if (!isMicrosoftNextLink(token)) {
        throw new ProviderValidationError(PROVIDER_ID, "Token de paginação inválido.");
    }
    return token;
}

function serializeAttendees(attendees: readonly string[]) {
    return attendees.map(address => ({
        emailAddress: { address },
        type: "required",
    }));
}

function validateRange(start: ProviderDateTime, end: ProviderDateTime): void {
    if (start.date.getTime() >= end.date.getTime()) {
        throw new ProviderValidationError(
            PROVIDER_ID,
            "O fim do evento precisa ocorrer depois do início.",
        );
    }
}

function validateAllDayCompatibility(start: ProviderDateTime, end: ProviderDateTime): void {
    if (start.allDay !== end.allDay) {
        throw new ProviderValidationError(
            PROVIDER_ID,
            "Início e fim precisam usar o mesmo modo de data.",
        );
    }
    if (start.allDay && start.timeZone !== end.timeZone) {
        throw new ProviderValidationError(
            PROVIDER_ID,
            "Eventos de dia inteiro precisam usar o mesmo fuso no início e no fim.",
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

function normalize(value: string): string {
    return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) return minimum;
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
