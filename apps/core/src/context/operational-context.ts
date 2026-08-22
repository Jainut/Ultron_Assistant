export type OperationalEntityType =
    | "email"
    | "task"
    | "calendar-event"
    | "device"
    | "file"
    | "application"
    | "project";

export interface OperationalReference {
    type: OperationalEntityType;
    id: string;
    label?: string;
    provider?: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
}

export interface OperationalContextSnapshot {
    activeEmail?: OperationalReference;
    activeTask?: OperationalReference;
    activeCalendarEvent?: OperationalReference;
    activeDevice?: OperationalReference;
    activeFile?: OperationalReference;
    activeApplication?: OperationalReference;
    activeProject?: OperationalReference;
}

type ContextKey = keyof OperationalContextSnapshot;

const keyForType: Record<OperationalEntityType, ContextKey> = {
    email: "activeEmail",
    task: "activeTask",
    "calendar-event": "activeCalendarEvent",
    device: "activeDevice",
    file: "activeFile",
    application: "activeApplication",
    project: "activeProject",
};

/** Memória operacional estruturada; não substitui o histórico conversacional. */
export class OperationalContext {
    private state: OperationalContextSnapshot = {};

    set(
        reference: Omit<OperationalReference, "updatedAt"> & { updatedAt?: string },
    ): OperationalReference {
        const normalized: OperationalReference = {
            ...reference,
            updatedAt: reference.updatedAt ?? new Date().toISOString(),
        };
        this.state = {
            ...this.state,
            [keyForType[reference.type]]: normalized,
        };
        return normalized;
    }

    get(type: OperationalEntityType): OperationalReference | undefined {
        return this.state[keyForType[type]];
    }

    snapshot(): Readonly<OperationalContextSnapshot> {
        return { ...this.state };
    }

    clear(type?: OperationalEntityType): void {
        if (!type) {
            this.state = {};
            return;
        }

        const key = keyForType[type];
        const next = { ...this.state };
        delete next[key];
        this.state = next;
    }
}

export const operationalContext = new OperationalContext();
