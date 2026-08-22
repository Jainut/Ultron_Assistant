import type {
    ProviderIdentity,
    ProviderRequestContext,
    UserConfirmation,
} from "./provider.ts";
import type {
    ExternalSourceReference,
    Page,
    ProviderDateTime,
    UntrustedExternalText,
} from "./types.ts";

export type TaskStatus = "needsAction" | "completed";

export interface ProviderTask {
    readonly id: string;
    readonly listId: string;
    readonly title: UntrustedExternalText;
    readonly notes?: UntrustedExternalText;
    readonly status: TaskStatus;
    readonly due?: ProviderDateTime;
    readonly completedAt?: ProviderDateTime;
    readonly updatedAt?: ProviderDateTime;
    readonly source?: ExternalSourceReference;
    readonly parentId?: string;
}

export interface ListTasksOptions extends ProviderRequestContext {
    readonly taskListId?: string;
    readonly includeCompleted?: boolean;
    readonly dueMin?: ProviderDateTime;
    readonly dueMax?: ProviderDateTime;
    readonly maxResults?: number;
    readonly pageToken?: string;
}

export interface SearchTasksOptions extends ListTasksOptions {
    readonly query: string;
}

export interface CreateTaskInput {
    readonly taskListId?: string;
    readonly title: string;
    readonly notes?: string;
    readonly due?: ProviderDateTime;
    readonly source?: ExternalSourceReference;
    readonly parentId?: string;
}

export interface UpdateTaskInput {
    readonly taskListId?: string;
    readonly title?: string;
    readonly notes?: string;
    readonly due?: ProviderDateTime | null;
    readonly source?: ExternalSourceReference | null;
}

export interface TaskProvider extends ProviderIdentity {
    readonly kind: "tasks";

    listTasks(options?: ListTasksOptions): Promise<Page<ProviderTask>>;
    searchTasks(options: SearchTasksOptions): Promise<Page<ProviderTask>>;
    getTask(
        taskId: string,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask>;
    createTask(input: CreateTaskInput, context?: ProviderRequestContext): Promise<ProviderTask>;
    updateTask(
        taskId: string,
        input: UpdateTaskInput,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask>;
    completeTask(
        taskId: string,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<ProviderTask>;
    deleteTask(
        taskId: string,
        confirmation: UserConfirmation,
        taskListId?: string,
        context?: ProviderRequestContext,
    ): Promise<void>;
}
