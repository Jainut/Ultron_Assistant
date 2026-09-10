import type { FetchTransport } from "../../security/oauth2-desktop.ts";
import {
    ProviderNotFoundError,
    ProviderValidationError,
    requireUserConfirmation,
    type ProviderHealth,
    type ProviderRequestContext,
    type UserConfirmation,
} from "../provider.ts";
import type {
    CreateTaskInput,
    ListTasksOptions,
    ProviderTask,
    SearchTasksOptions,
    TaskProvider,
    UpdateTaskInput,
} from "../task-provider.ts";
import {
    providerDateTime,
    untrustedText,
    type ExternalSourceReference,
    type Page,
} from "../types.ts";
import {
    isMicrosoftNextLink,
    MicrosoftGraphClient,
    parseMicrosoftDateTime,
    serializeMicrosoftDateTime,
    type MicrosoftGraphDateTime,
} from "./microsoft-graph-client.ts";
import type { AccessTokenSource } from "../oauth-api-client.ts";

const PROVIDER_ID = "microsoft.todo";
const DEFAULT_LIST_SENTINELS = new Set(["", "default", "@default"]);
const SOURCE_PREFIX = "ultron:v1:";

interface GraphCollection<T> {
    readonly value?: T[];
    readonly "@odata.nextLink"?: string;
}

interface MicrosoftTodoListResource {
    readonly id?: string;
    readonly displayName?: string;
    readonly isOwner?: boolean;
    readonly wellknownListName?: string;
}

interface MicrosoftLinkedResource {
    readonly id?: string;
    readonly webUrl?: string;
    readonly applicationName?: string;
    readonly displayName?: string;
    readonly externalId?: string;
}

interface MicrosoftTodoTaskResource {
    readonly id?: string;
    readonly title?: string;
    readonly body?: {
        readonly content?: string;
        readonly contentType?: string;
    };
    readonly status?: string;
    readonly dueDateTime?: MicrosoftGraphDateTime | null;
    readonly completedDateTime?: MicrosoftGraphDateTime | null;
    readonly lastModifiedDateTime?: string;
    readonly linkedResources?: MicrosoftLinkedResource[];
}

export interface MicrosoftTodoProviderOptions {
    readonly oauth: AccessTokenSource;
    readonly transport?: FetchTransport;
    readonly defaultTaskListId?: string;
    readonly timeZone?: string;
}

export class MicrosoftTodoProvider implements TaskProvider {
    readonly id = PROVIDER_ID;
    readonly kind = "tasks" as const;
    readonly displayName = "Microsoft To Do";

    private readonly api: MicrosoftGraphClient;
    private readonly configuredListId?: string;
    private readonly timeZone: string;
    private cachedDefaultListId?: string;

    constructor(options: MicrosoftTodoProviderOptions) {
        this.api = new MicrosoftGraphClient(
            this.id,
            options.oauth,
            options.transport,
        );
        this.configuredListId = normalized(options.defaultTaskListId);
        this.timeZone = normalized(options.timeZone)
            ?? Intl.DateTimeFormat().resolvedOptions().timeZone
            ?? "UTC";
    }

    async healthCheck(context?: ProviderRequestContext): Promise<ProviderHealth> {
        const listId = await this.listId(undefined, context?.signal);
        await this.api.request(`me/todo/lists/${encodeURIComponent(listId)}`, {
            signal: context?.signal,
        });
        return { providerId: this.id, status: "ready", checkedAt: new Date() };
    }

    async listTasks(options: ListTasksOptions = {}): Promise<Page<ProviderTask>> {
        const listId = await this.listId(options.taskListId, options.signal);
        const limit = clamp(options.maxResults ?? 50, 1, 100);
        const path = pagePath(
            options.pageToken,
            `me/todo/lists/${encodeURIComponent(listId)}/tasks`,
        );
        const resource = await this.api.request<GraphCollection<MicrosoftTodoTaskResource>>(
            path,
            {
                query: options.pageToken ? undefined : {
                    "$top": Math.max(limit, 50),
                    "$expand": "linkedResources",
                },
                headers: graphTimeZoneHeaders(),
                signal: options.signal,
            },
        );
        const items = (resource.value ?? [])
            .map(task => this.parseTask(task, listId))
            .filter(task => options.includeCompleted || task.status !== "completed")
            .filter(task => withinDueRange(task, options))
            .slice(0, limit);
        const nextLink = resource["@odata.nextLink"];
        return {
            items,
            ...(isMicrosoftNextLink(nextLink) ? { nextPageToken: nextLink } : {}),
        };
    }

    async searchTasks(options: SearchTasksOptions): Promise<Page<ProviderTask>> {
        const query = normalize(options.query);
        if (!query) {
            throw new ProviderValidationError(this.id, "A busca de tarefas não pode ser vazia.");
        }
        const page = await this.listTasks({
            ...options,
            maxResults: Math.max(options.maxResults ?? 50, 100),
        });
        return {
            items: page.items.filter(task => (
                normalize(task.title.value).includes(query)
                || normalize(task.notes?.value ?? "").includes(query)
            )).slice(0, clamp(options.maxResults ?? 50, 1, 100)),
            nextPageToken: page.nextPageToken,
        };
    }

    async getTask(
        taskId: string,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask> {
        this.validateTaskId(taskId);
        const listId = await this.listId(taskListId, context?.signal);
        return this.parseTask(
            await this.getTaskResource(taskId, listId, context?.signal),
            listId,
        );
    }

    async createTask(
        input: CreateTaskInput,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask> {
        if (!input.title.trim()) {
            throw new ProviderValidationError(this.id, "Título da tarefa é obrigatório.");
        }
        if (input.parentId) {
            throw new ProviderValidationError(
                this.id,
                "O Microsoft To Do não oferece tarefas-filhas por este endpoint.",
            );
        }
        const listId = await this.listId(input.taskListId, context?.signal);
        const linked = input.source ? serializeSource(input.source) : undefined;
        if (input.source && !linked) {
            throw new ProviderValidationError(
                this.id,
                "A origem da tarefa não possui um link seguro que o Microsoft To Do aceite.",
            );
        }
        const resource = await this.api.request<MicrosoftTodoTaskResource>(
            `me/todo/lists/${encodeURIComponent(listId)}/tasks`,
            {
                method: "POST",
                body: {
                    title: input.title,
                    ...(input.notes !== undefined
                        ? { body: { content: input.notes, contentType: "text" } }
                        : {}),
                    ...(input.due
                        ? { dueDateTime: serializeMicrosoftDateTime(input.due) }
                        : {}),
                    ...(linked ? { linkedResources: [linked] } : {}),
                },
                headers: graphTimeZoneHeaders(),
                signal: context?.signal,
            },
        );
        return this.parseTask(resource, listId);
    }

    async updateTask(
        taskId: string,
        input: UpdateTaskInput,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask> {
        this.validateTaskId(taskId);
        if (input.title !== undefined && !input.title.trim()) {
            throw new ProviderValidationError(this.id, "Título da tarefa é obrigatório.");
        }
        const listId = await this.listId(input.taskListId, context?.signal);
        const body: Record<string, unknown> = {};
        if (input.title !== undefined) body.title = input.title;
        if (input.notes !== undefined) {
            body.body = { content: input.notes, contentType: "text" };
        }
        if (input.due !== undefined) {
            body.dueDateTime = input.due
                ? serializeMicrosoftDateTime(input.due)
                : null;
        }
        const sourceSnapshot = input.source !== undefined
            ? await this.getTaskResource(taskId, listId, context?.signal)
            : undefined;

        let resource = Object.keys(body).length > 0
            ? await this.api.request<MicrosoftTodoTaskResource>(
                this.taskPath(listId, taskId),
                {
                    method: "PATCH",
                    body,
                    headers: graphTimeZoneHeaders(),
                    signal: context?.signal,
                },
            )
            : sourceSnapshot
                ?? await this.getTaskResource(taskId, listId, context?.signal);

        if (input.source !== undefined) {
            await this.updateSource(
                taskId,
                listId,
                sourceSnapshot?.linkedResources ?? [],
                input.source,
                context?.signal,
            );
            resource = await this.getTaskResource(taskId, listId, context?.signal);
        }
        return this.parseTask(resource, listId);
    }

    async completeTask(
        taskId: string,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask> {
        this.validateTaskId(taskId);
        const listId = await this.listId(taskListId, context?.signal);
        const resource = await this.api.request<MicrosoftTodoTaskResource>(
            this.taskPath(listId, taskId),
            {
                method: "PATCH",
                body: { status: "completed" },
                headers: graphTimeZoneHeaders(),
                signal: context?.signal,
            },
        );
        return this.parseTask(resource, listId);
    }

    async deleteTask(
        taskId: string,
        confirmation: UserConfirmation,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<void> {
        requireUserConfirmation(this.id, confirmation, "task.delete");
        this.validateTaskId(taskId);
        const listId = await this.listId(taskListId, context?.signal);
        await this.api.request(this.taskPath(listId, taskId), {
            method: "DELETE",
            signal: context?.signal,
        });
    }

    private async listId(value: string | undefined, signal?: AbortSignal): Promise<string> {
        const requested = value?.trim() ?? "";
        if (requested && !DEFAULT_LIST_SENTINELS.has(requested.toLowerCase())) {
            return requested;
        }
        if (this.configuredListId) return this.configuredListId;
        if (this.cachedDefaultListId) return this.cachedDefaultListId;

        const resource = await this.api.request<GraphCollection<MicrosoftTodoListResource>>(
            "me/todo/lists",
            {
                query: { "$top": 100 },
                signal,
            },
        );
        const lists = resource.value ?? [];
        const selected = lists.find(list => list.wellknownListName === "defaultList")
            ?? lists.find(list => list.isOwner !== false)
            ?? lists[0];
        if (!selected?.id) {
            throw new ProviderNotFoundError(this.id, "Lista padrão do Microsoft To Do");
        }
        this.cachedDefaultListId = selected.id;
        return selected.id;
    }

    private taskPath(listId: string, taskId: string): string {
        return `me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
    }

    private async getTaskResource(
        taskId: string,
        listId: string,
        signal?: AbortSignal,
    ): Promise<MicrosoftTodoTaskResource> {
        return await this.api.request<MicrosoftTodoTaskResource>(
            this.taskPath(listId, taskId),
            {
                query: { "$expand": "linkedResources" },
                headers: graphTimeZoneHeaders(),
                signal,
            },
        );
    }

    private async updateSource(
        taskId: string,
        listId: string,
        current: readonly MicrosoftLinkedResource[],
        source: ExternalSourceReference | null,
        signal?: AbortSignal,
    ): Promise<void> {
        const owned = current.filter(item => item.applicationName === "Ultron" && item.id);
        const base = `${this.taskPath(listId, taskId)}/linkedResources`;
        if (source === null) {
            for (const item of owned) {
                await this.api.request(`${base}/${encodeURIComponent(item.id!)}`, {
                    method: "DELETE",
                    signal,
                });
            }
            return;
        }

        const linked = serializeSource(source);
        if (!linked) {
            throw new ProviderValidationError(
                this.id,
                "A origem da tarefa não possui um link seguro que o Microsoft To Do aceite.",
            );
        }
        const first = owned[0];
        if (first?.id) {
            await this.api.request(`${base}/${encodeURIComponent(first.id)}`, {
                method: "PATCH",
                body: linked,
                signal,
            });
            for (const duplicate of owned.slice(1)) {
                await this.api.request(`${base}/${encodeURIComponent(duplicate.id!)}`, {
                    method: "DELETE",
                    signal,
                });
            }
        } else {
            await this.api.request(base, { method: "POST", body: linked, signal });
        }
    }

    private parseTask(resource: MicrosoftTodoTaskResource, listId: string): ProviderTask {
        const id = resource.id ?? "unknown";
        const due = parseMicrosoftDateTime(resource.dueDateTime ?? undefined, this.timeZone);
        const completed = parseMicrosoftDateTime(
            resource.completedDateTime ?? undefined,
            this.timeZone,
        );
        const updated = parseAbsolute(resource.lastModifiedDateTime, this.timeZone);
        const source = (resource.linkedResources ?? [])
            .map(parseSource)
            .find((value): value is ExternalSourceReference => value !== undefined);
        return {
            id,
            listId,
            title: untrustedText(resource.title, this.id, id, "title"),
            ...(resource.body?.content
                ? { notes: untrustedText(resource.body.content, this.id, id, "body.content") }
                : {}),
            status: resource.status === "completed" ? "completed" : "needsAction",
            ...(due ? { due } : {}),
            ...(completed ? { completedAt: completed } : {}),
            ...(updated ? { updatedAt: updated } : {}),
            ...(source ? { source } : {}),
        };
    }

    private validateTaskId(value: string): void {
        if (!value.trim()) {
            throw new ProviderValidationError(this.id, "ID da tarefa é obrigatório.");
        }
    }
}

function withinDueRange(task: ProviderTask, options: ListTasksOptions): boolean {
    if (options.dueMin && (!task.due || task.due.date < options.dueMin.date)) return false;
    if (options.dueMax && (!task.due || task.due.date >= options.dueMax.date)) return false;
    return true;
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

function serializeSource(
    source: ExternalSourceReference,
): Omit<MicrosoftLinkedResource, "id"> | undefined {
    const webUrl = safeSourceUrl(source);
    if (!webUrl) return undefined;
    const encoded = Buffer.from(JSON.stringify(source), "utf8").toString("base64url");
    if (`${SOURCE_PREFIX}${encoded}`.length > 8_192) return undefined;
    return {
        webUrl,
        applicationName: "Ultron",
        displayName: `${source.type}: ${source.resourceId}`,
        externalId: `${SOURCE_PREFIX}${encoded}`,
    };
}

function parseSource(value: MicrosoftLinkedResource): ExternalSourceReference | undefined {
    if (
        value.applicationName !== "Ultron"
        || !value.externalId?.startsWith(SOURCE_PREFIX)
        || value.externalId.length > 8_192
    ) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(Buffer.from(
            value.externalId.slice(SOURCE_PREFIX.length),
            "base64url",
        ).toString("utf8"));
        return sanitizeSourceReference(parsed);
    } catch {
        return undefined;
    }
}

function safeSourceUrl(source: ExternalSourceReference): string | undefined {
    if (source.url) {
        try {
            const url = new URL(source.url);
            if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
        } catch {
            // Ignore an invalid explicit URL and try the provider-safe fallback.
        }
    }
    if (source.provider === "google.gmail") {
        return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(source.resourceId)}`;
    }
    return undefined;
}

function sanitizeSourceReference(value: unknown): ExternalSourceReference | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const valid = record.trust === "untrusted"
        && typeof record.provider === "string"
        && typeof record.type === "string"
        && typeof record.resourceId === "string"
        && (record.threadId === undefined || typeof record.threadId === "string")
        && (record.url === undefined || typeof record.url === "string")
        && (
            record.metadata === undefined
            || (
                record.metadata !== null
                && typeof record.metadata === "object"
                && !Array.isArray(record.metadata)
                && Object.values(record.metadata).every(item => typeof item === "string")
            )
        );
    if (!valid) return undefined;
    return {
        trust: "untrusted",
        provider: record.provider as string,
        type: record.type as string,
        resourceId: record.resourceId as string,
        ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}),
        ...(typeof record.url === "string" ? { url: record.url } : {}),
        ...(record.metadata && typeof record.metadata === "object"
            ? { metadata: { ...(record.metadata as Record<string, string>) } }
            : {}),
    };
}

function parseAbsolute(value: string | undefined, timeZone: string) {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? providerDateTime(date, timeZone) : undefined;
}

function normalized(value: string | undefined): string | undefined {
    return value?.trim() || undefined;
}

function normalize(value: string): string {
    return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) return minimum;
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
