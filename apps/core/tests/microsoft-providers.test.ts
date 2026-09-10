import assert from "node:assert/strict";
import test from "node:test";

import { MicrosoftCalendarProvider } from "../src/providers/microsoft/microsoft-calendar.provider.ts";
import { createMicrosoftOAuthClient } from "../src/providers/microsoft/microsoft-oauth.ts";
import { MicrosoftTodoProvider } from "../src/providers/microsoft/microsoft-todo.provider.ts";
import {
    ProviderConflictError,
    ProviderValidationError,
    type UserConfirmation,
} from "../src/providers/provider.ts";
import { providerDateTime } from "../src/providers/types.ts";
import { InMemorySecretStore } from "../src/security/secret-store.ts";
import type { FetchTransport } from "../src/security/oauth2-desktop.ts";

const oauth = {
    async getAccessToken(): Promise<string> {
        return "microsoft-test-token";
    },
};

const confirmed = (action: string): UserConfirmation => ({
    confirmedByUser: true,
    confirmedAt: new Date(),
    action,
});

test("Microsoft OAuth usa tenant v2, PKCE loopback e scopes mínimos escolhidos", async () => {
    const store = new InMemorySecretStore({ insecurePurpose: "tests-only" });
    let authorizationUrl: URL | undefined;
    const client = createMicrosoftOAuthClient({
        clientId: "microsoft-client-id",
        tenant: "common",
        scopes: ["offline_access", "Tasks.ReadWrite", "Calendars.ReadWrite"],
        transport: async (_input, init) => {
            const form = new URLSearchParams(String(init?.body));
            assert.equal(form.get("grant_type"), "authorization_code");
            assert.equal(form.get("redirect_uri")?.startsWith("http://localhost:"), true);
            return jsonResponse({
                access_token: "graph-token",
                refresh_token: "graph-refresh",
                token_type: "Bearer",
                expires_in: 3600,
                scope: "Tasks.ReadWrite Calendars.ReadWrite",
            });
        },
    }, store);

    const state = await client.authorizeInteractive({
        timeoutMs: 5_000,
        openAuthorizationUrl: async url => {
            authorizationUrl = url;
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.searchParams.set("state", url.searchParams.get("state")!);
            callback.searchParams.set("code", "microsoft-code");
            assert.equal((await fetch(callback)).status, 200);
        },
    });

    assert.equal(state.authorized, true);
    assert.equal(authorizationUrl?.pathname, "/common/oauth2/v2.0/authorize");
    assert.equal(
        authorizationUrl?.searchParams.get("scope"),
        "offline_access Tasks.ReadWrite Calendars.ReadWrite",
    );
    assert.throws(() => createMicrosoftOAuthClient({
        clientId: "microsoft-client-id",
        tenant: "../common",
        scopes: ["Tasks.ReadWrite"],
    }, store), TypeError);
});

test("Microsoft To Do resolve a lista padrão, preserva origem e protege exclusão", async () => {
    const requests: Array<{ url: URL; init?: RequestInit; body?: Record<string, unknown> }> = [];
    const transport: FetchTransport = async (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        const body = init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : undefined;
        requests.push({ url, init, body });
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer microsoft-test-token");

        if (method === "GET" && url.pathname.endsWith("/me/todo/lists")) {
            return jsonResponse({ value: [
                { id: "flagged", wellknownListName: "flaggedEmails" },
                { id: "tasks-list", wellknownListName: "defaultList", isOwner: true },
            ] });
        }
        if (method === "GET" && url.pathname.endsWith("/tasks")) {
            return jsonResponse({
                value: [
                    todoTask("active", "Responder contrato", "notStarted", "2026-08-22T02:00:00.0000000"),
                    todoTask("completed", "Já feita", "completed", "2026-08-22T02:00:00.0000000"),
                    todoTask("future", "Depois", "notStarted", "2026-09-22T02:00:00.0000000"),
                ],
                "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/todo/lists/tasks-list/tasks?$skiptoken=safe",
            });
        }
        if (method === "POST" && url.pathname.endsWith("/tasks")) {
            return jsonResponse({
                id: "created",
                status: "notStarted",
                lastModifiedDateTime: "2026-08-20T12:00:00Z",
                ...body,
            }, 201);
        }
        if (method === "PATCH" && url.pathname.endsWith("/tasks/created")) {
            return jsonResponse({
                id: "created",
                title: "Responder email",
                status: body?.status ?? "notStarted",
                body: { content: "Preparar resposta", contentType: "text" },
            });
        }
        if (method === "DELETE" && url.pathname.endsWith("/tasks/created")) {
            return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected Microsoft To Do request: ${method} ${url}`);
    };
    const tasks = new MicrosoftTodoProvider({
        oauth,
        transport,
        timeZone: "America/Sao_Paulo",
    });

    const dueMax = providerDateTime("2026-08-23T03:00:00Z", "America/Sao_Paulo");
    const listed = await tasks.listTasks({ dueMax, maxResults: 10 });
    assert.deepEqual(listed.items.map(item => item.id), ["active"]);
    assert.equal(listed.items[0]?.title.trust, "untrusted");
    assert.match(listed.nextPageToken ?? "", /\$skiptoken=safe/);
    assert.equal(requests[1]?.url.searchParams.get("$expand"), "linkedResources");
    assert.equal(new Headers(requests[1]?.init?.headers).get("prefer"), 'outlook.timezone="UTC"');

    const source = {
        trust: "untrusted" as const,
        provider: "google.gmail",
        type: "email",
        resourceId: "message-123",
        threadId: "thread-123",
    };
    const due = providerDateTime("2026-08-21T23:00:00-03:00", "America/Sao_Paulo");
    const created = await tasks.createTask({
        title: "Responder email",
        notes: "Preparar resposta",
        due,
        source,
    });
    assert.equal(created.id, "created");
    assert.equal(created.due?.iso, due.iso);
    assert.equal(created.source?.resourceId, "message-123");
    const posted = requests.find(request => request.init?.method === "POST")?.body as {
        linkedResources: Array<{ externalId: string; webUrl: string }>;
        dueDateTime: { dateTime: string; timeZone: string };
    };
    assert.equal(posted.linkedResources[0]?.externalId.includes("message-123"), false);
    assert.match(posted.linkedResources[0]?.webUrl ?? "", /^https:\/\/mail\.google\.com/);
    assert.equal(posted.dueDateTime.timeZone, "UTC");
    assert.equal(posted.dueDateTime.dateTime.endsWith("Z"), false);
    assert.equal(requests.filter(request => request.url.pathname.endsWith("/me/todo/lists")).length, 1);

    const completed = await tasks.completeTask("created");
    assert.equal(completed.status, "completed");
    await assert.rejects(
        tasks.deleteTask("created", confirmed("task.other")),
        ProviderValidationError,
    );
    await tasks.deleteTask("created", confirmed("task.delete"));
    assert.equal(requests.at(-1)?.init?.method, "DELETE");
});

test("Outlook Calendar usa calendarView, evita conflito e mantém confirmação central", async () => {
    const requests: Array<{ url: URL; init?: RequestInit; body?: Record<string, unknown> }> = [];
    let returnConflict = true;
    const transport: FetchTransport = async (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? "GET";
        const body = init?.body
            ? JSON.parse(String(init.body)) as Record<string, unknown>
            : undefined;
        requests.push({ url, init, body });
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer microsoft-test-token");

        if (method === "GET" && url.pathname.endsWith("/calendarView")) {
            return jsonResponse({ value: returnConflict ? [calendarEvent("busy", "Ocupado")] : [] });
        }
        if (method === "POST" && url.pathname.endsWith("/calendar/events")) {
            return jsonResponse({
                id: "created-event",
                showAs: "busy",
                subject: body?.subject,
                start: body?.start,
                end: body?.end,
                isAllDay: body?.isAllDay,
                attendees: body?.attendees,
            }, 201);
        }
        if (method === "PATCH" && url.pathname.endsWith("/events/created-event")) {
            return jsonResponse({
                id: "created-event",
                showAs: "busy",
                subject: body?.subject,
                start: graphDateTime("2026-08-21T18:00:00.0000000"),
                end: graphDateTime("2026-08-21T19:00:00.0000000"),
                attendees: [],
            });
        }
        if (method === "DELETE" && url.pathname.endsWith("/events/created-event")) {
            return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected Outlook Calendar request: ${method} ${url}`);
    };
    const calendar = new MicrosoftCalendarProvider({
        oauth,
        transport,
        timeZone: "America/Sao_Paulo",
    });
    const start = providerDateTime("2026-08-21T15:00:00-03:00", "America/Sao_Paulo");
    const end = providerDateTime("2026-08-21T16:00:00-03:00", "America/Sao_Paulo");

    await assert.rejects(
        calendar.createEvent({ summary: "Entrevista", start, end }),
        ProviderConflictError,
    );
    assert.equal(requests.some(request => request.init?.method === "POST"), false);
    const conflictRequest = requests[0]!;
    assert.equal(conflictRequest.url.pathname, "/v1.0/me/calendar/calendarView");
    assert.equal(conflictRequest.url.searchParams.get("startDateTime"), start.iso);
    assert.equal(new Headers(conflictRequest.init?.headers).get("prefer"), 'outlook.timezone="UTC"');

    returnConflict = false;
    const created = await calendar.createEvent({
        summary: "Entrevista",
        description: "Conversa técnica",
        start,
        end,
        attendees: ["pessoa@example.com"],
    });
    assert.equal(created.id, "created-event");
    assert.equal(created.summary.trust, "untrusted");
    assert.equal(created.start.iso, start.iso);
    const post = requests.find(request => request.init?.method === "POST")?.body as {
        subject: string;
        start: { dateTime: string; timeZone: string };
        attendees: Array<{ emailAddress: { address: string } }>;
    };
    assert.equal(post.subject, "Entrevista");
    assert.equal(post.start.timeZone, "UTC");
    assert.equal(post.start.dateTime, "2026-08-21T18:00:00.000");
    assert.equal(post.attendees[0]?.emailAddress.address, "pessoa@example.com");

    const updated = await calendar.updateEvent("created-event", { summary: "Entrevista final" });
    assert.equal(updated.summary.value, "Entrevista final");

    const allDayStart = providerDateTime(
        "2026-08-22T03:00:00.000Z",
        "America/Sao_Paulo",
        true,
    );
    const allDayEnd = providerDateTime(
        "2026-08-23T03:00:00.000Z",
        "America/Sao_Paulo",
        true,
    );
    const allDay = await calendar.createEvent({
        summary: "Dia inteiro",
        start: allDayStart,
        end: allDayEnd,
        checkConflicts: false,
    });
    const allDayPost = requests.filter(request => request.init?.method === "POST").at(-1)?.body as {
        start: { dateTime: string; timeZone: string };
        end: { dateTime: string; timeZone: string };
        isAllDay: boolean;
    };
    assert.deepEqual(allDayPost.start, {
        dateTime: "2026-08-22T00:00:00.000",
        timeZone: "America/Sao_Paulo",
    });
    assert.equal(allDayPost.end.dateTime, "2026-08-23T00:00:00.000");
    assert.equal(allDayPost.isAllDay, true);
    assert.equal(allDay.start.iso, allDayStart.iso);

    await assert.rejects(
        calendar.cancelEvent("created-event", confirmed("calendar.other")),
        ProviderValidationError,
    );
    await calendar.cancelEvent("created-event", confirmed("calendar.cancel"));
    assert.equal(requests.at(-1)?.init?.method, "DELETE");
});

test("providers Microsoft rejeitam paginação fora do Graph antes da rede", async () => {
    let requests = 0;
    const transport: FetchTransport = async () => {
        requests += 1;
        return jsonResponse({ value: [] });
    };
    const tasks = new MicrosoftTodoProvider({
        oauth,
        transport,
        defaultTaskListId: "tasks-list",
    });
    const calendar = new MicrosoftCalendarProvider({ oauth, transport });
    const start = providerDateTime("2026-08-21T03:00:00Z", "America/Sao_Paulo");
    const end = providerDateTime("2026-08-22T03:00:00Z", "America/Sao_Paulo");

    await assert.rejects(
        tasks.listTasks({ pageToken: "https://attacker.example/steal" }),
        ProviderValidationError,
    );
    await assert.rejects(
        calendar.listEvents({
            timeMin: start,
            timeMax: end,
            pageToken: "https://attacker.example/steal",
        }),
        ProviderValidationError,
    );
    assert.equal(requests, 0);
});

function todoTask(id: string, title: string, status: string, due: string) {
    return {
        id,
        title,
        status,
        body: { content: `${title} notas`, contentType: "text" },
        dueDateTime: graphDateTime(due),
        lastModifiedDateTime: "2026-08-20T12:00:00Z",
        linkedResources: [],
    };
}

function calendarEvent(id: string, subject: string) {
    return {
        id,
        subject,
        showAs: "busy",
        start: graphDateTime("2026-08-21T18:30:00.0000000"),
        end: graphDateTime("2026-08-21T19:30:00.0000000"),
        attendees: [],
    };
}

function graphDateTime(dateTime: string) {
    return { dateTime, timeZone: "UTC" };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}
