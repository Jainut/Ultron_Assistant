import type { FetchTransport } from "../../security/oauth2-desktop.ts";
import type {
    CreateTaskInput,
    ListTasksOptions,
    ProviderTask,
    SearchTasksOptions,
    TaskProvider,
    UpdateTaskInput,
} from "../task-provider.ts";
import {
    ProviderValidationError,
    requireUserConfirmation,
    type ProviderHealth,
    type ProviderRequestContext,
    type UserConfirmation,
} from "../provider.ts";
import {
    providerDateTime,
    untrustedText,
    type ExternalSourceReference,
    type Page,
} from "../types.ts";
import {
    GoogleApiClient,
    type AccessTokenSource,
} from "./google-api-client.ts";

const PROVIDER_ID = "google.tasks";
const TASKS_BASE_URL = "https://tasks.googleapis.com/tasks/v1/";
const METADATA_PREFIX = "<!-- ultron-task-metadata:v1:";
const METADATA_SUFFIX = " -->";

interface GoogleTaskResource {
    id?: string;
    title?: string;
    notes?: string;
    status?: string;
    due?: string;
    completed?: string;
    updated?: string;
    parent?: string;
}

interface GoogleTaskListResource {
    items?: GoogleTaskResource[];
    nextPageToken?: string;
}

interface StoredTaskMetadata {
    readonly source?: ExternalSourceReference;
    readonly dueTimeZone?: string;
}

export interface GoogleTasksProviderOptions {
    readonly oauth: AccessTokenSource;
    readonly transport?: FetchTransport;
    readonly defaultTaskListId?: string;
    readonly timeZone?: string;
}

export class GoogleTasksProvider implements TaskProvider {
    readonly id = PROVIDER_ID;
    readonly kind = "tasks" as const;
    readonly displayName = "Google Tasks";

    private readonly api: GoogleApiClient;
    private readonly defaultTaskListId: string;
    private readonly timeZone: string;

    constructor(options: GoogleTasksProviderOptions) {
        this.api = new GoogleApiClient(
            this.id,
            TASKS_BASE_URL,
            options.oauth,
            options.transport,
        );
        this.defaultTaskListId = options.defaultTaskListId?.trim() || "@default";
        this.timeZone = options.timeZone?.trim()
            || Intl.DateTimeFormat().resolvedOptions().timeZone
            || "UTC";
    }

    async healthCheck(context?: ProviderRequestContext): Promise<ProviderHealth> {
        await this.api.request(
            `users/@me/lists/${encodeURIComponent(this.defaultTaskListId)}`,
            { signal: context?.signal },
        );
        return { providerId: this.id, status: "ready", checkedAt: new Date() };
    }

    async listTasks(options: ListTasksOptions = {}): Promise<Page<ProviderTask>> {
        const listId = this.listId(options.taskListId);
        const resource = await this.api.request<GoogleTaskListResource>(
            `lists/${encodeURIComponent(listId)}/tasks`,
            {
                query: {
                    showCompleted: options.includeCompleted ?? false,
                    showHidden: options.includeCompleted ?? false,
                    dueMin: options.dueMin?.iso,
                    dueMax: options.dueMax?.iso,
                    maxResults: clamp(options.maxResults ?? 50, 1, 100),
                    pageToken: options.pageToken,
                },
                signal: options.signal,
            },
        );
        return {
            items: (resource.items ?? []).map(task => this.parseTask(task, listId)),
            nextPageToken: resource.nextPageToken,
        };
    }

    async searchTasks(options: SearchTasksOptions): Promise<Page<ProviderTask>> {
        if (!options.query.trim()) {
            throw new ProviderValidationError(this.id, "A busca de tarefas não pode ser vazia.");
        }
        const page = await this.listTasks({
            ...options,
            maxResults: Math.max(options.maxResults ?? 50, 100),
        });
        const query = normalize(options.query);
        return {
            items: page.items.filter(task => (
                normalize(task.title.value).includes(query)
                || normalize(task.notes?.value ?? "").includes(query)
            )),
            nextPageToken: page.nextPageToken,
        };
    }

    async getTask(
        taskId: string,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask> {
        this.validateTaskId(taskId);
        const listId = this.listId(taskListId);
        const task = await this.api.request<GoogleTaskResource>(
            `lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
            { signal: context?.signal },
        );
        return this.parseTask(task, listId);
    }

    async createTask(
        input: CreateTaskInput,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask> {
        if (!input.title.trim()) {
            throw new ProviderValidationError(this.id, "Título da tarefa é obrigatório.");
        }
        const listId = this.listId(input.taskListId);
        const task = await this.api.request<GoogleTaskResource>(
            `lists/${encodeURIComponent(listId)}/tasks`,
            {
                method: "POST",
                query: { parent: input.parentId },
                body: {
                    title: input.title,
                    ...(input.notes !== undefined || input.source || input.due
                        ? {
                            notes: encodeNotes(input.notes ?? "", {
                                source: input.source,
                                dueTimeZone: input.due?.timeZone,
                            }),
                        }
                        : {}),
                    ...(input.due ? { due: input.due.iso } : {}),
                },
                signal: context?.signal,
            },
        );
        return this.parseTask(task, listId);
    }

    async updateTask(
        taskId: string,
        input: UpdateTaskInput,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask> {
        this.validateTaskId(taskId);
        const listId = this.listId(input.taskListId);
        if (input.title !== undefined && !input.title.trim()) {
            throw new ProviderValidationError(this.id, "Título da tarefa é obrigatório.");
        }

        const metadataChanges = input.notes !== undefined
            || input.source !== undefined
            || input.due !== undefined;
        const current = metadataChanges
            ? await this.getTask(taskId, listId, context)
            : undefined;
        const source = input.source === null
            ? undefined
            : input.source ?? current?.source;
        const dueTimeZone = input.due === null
            ? undefined
            : input.due?.timeZone ?? current?.due?.timeZone;
        const notes = input.notes ?? current?.notes?.value ?? "";

        const body: Record<string, unknown> = {};
        if (input.title !== undefined) body.title = input.title;
        if (metadataChanges) body.notes = encodeNotes(notes, { source, dueTimeZone });
        if (input.due !== undefined) body.due = input.due?.iso ?? null;

        const task = await this.api.request<GoogleTaskResource>(
            `lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
            {
                method: "PATCH",
                body,
                signal: context?.signal,
            },
        );
        return this.parseTask(task, listId);
    }

    async completeTask(
        taskId: string,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask> {
        this.validateTaskId(taskId);
        const listId = this.listId(taskListId);
        const task = await this.api.request<GoogleTaskResource>(
            `lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
            {
                method: "PATCH",
                body: { status: "completed", completed: new Date().toISOString() },
                signal: context?.signal,
            },
        );
        return this.parseTask(task, listId);
    }

    async deleteTask(
        taskId: string,
        confirmation: UserConfirmation,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<void> {
        requireUserConfirmation(this.id, confirmation, "task.delete");
        this.validateTaskId(taskId);
        const listId = this.listId(taskListId);
        await this.api.request(
            `lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
            { method: "DELETE", signal: context?.signal },
        );
    }

    private parseTask(resource: GoogleTaskResource, listId: string): ProviderTask {
        const id = resource.id ?? "unknown";
        const decoded = decodeNotes(resource.notes);
        const metadata = decoded.metadata;
        const dueTimeZone = metadata?.dueTimeZone || this.timeZone;
        const due = validDate(resource.due);
        const completed = validDate(resource.completed);
        const updated = validDate(resource.updated);

        return {
            id,
            listId,
            title: untrustedText(resource.title, this.id, id, "title"),
            ...(decoded.notes
                ? { notes: untrustedText(decoded.notes, this.id, id, "notes") }
                : {}),
            status: resource.status === "completed" ? "completed" : "needsAction",
            ...(due ? { due: providerDateTime(due, dueTimeZone) } : {}),
            ...(completed ? { completedAt: providerDateTime(completed, this.timeZone) } : {}),
            ...(updated ? { updatedAt: providerDateTime(updated, this.timeZone) } : {}),
            ...(metadata?.source ? { source: metadata.source } : {}),
            ...(resource.parent ? { parentId: resource.parent } : {}),
        };
    }

    private listId(value: string | undefined): string {
        return value?.trim() || this.defaultTaskListId;
    }

    private validateTaskId(value: string): void {
        if (!value.trim()) {
            throw new ProviderValidationError(this.id, "ID da tarefa é obrigatório.");
        }
    }
}

function encodeNotes(notes: string, metadata: StoredTaskMetadata): string {
    if (!metadata.source && !metadata.dueTimeZone) return notes;
    const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
    return `${notes.replace(metadataPattern(), "").trimEnd()}\n\n${METADATA_PREFIX}${encoded}${METADATA_SUFFIX}`;
}

function decodeNotes(value: string | undefined): {
    notes: string;
    metadata?: StoredTaskMetadata;
} {
    if (!value) return { notes: "" };
    const match = value.match(metadataPattern());
    if (!match?.[1]) return { notes: value };

    try {
        const parsed: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
        return {
            notes: value.replace(metadataPattern(), "").trimEnd(),
            ...(isStoredTaskMetadata(parsed) ? { metadata: parsed } : {}),
        };
    } catch {
        return { notes: value };
    }
}

function metadataPattern(): RegExp {
    return /\n*<!-- ultron-task-metadata:v1:([A-Za-z0-9_-]+) -->\s*$/;
}

function isStoredTaskMetadata(value: unknown): value is StoredTaskMetadata {
    if (!value || typeof value !== "object") return false;
    const metadata = value as Partial<StoredTaskMetadata>;
    if (metadata.dueTimeZone !== undefined && typeof metadata.dueTimeZone !== "string") {
        return false;
    }
    if (metadata.source === undefined) return true;
    const source = metadata.source as Partial<ExternalSourceReference>;
    return source.trust === "untrusted"
        && typeof source.provider === "string"
        && typeof source.type === "string"
        && typeof source.resourceId === "string";
}

function validDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
}

function normalize(value: string): string {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) return minimum;
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
