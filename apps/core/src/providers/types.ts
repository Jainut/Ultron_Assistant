/**
 * Text obtained from a remote provider. It is data, never an instruction.
 * Consumers must preserve this trust marker when passing content to an LLM.
 */
export interface UntrustedExternalText {
    readonly trust: "untrusted";
    readonly value: string;
    readonly source: {
        readonly providerId: string;
        readonly resourceId: string;
        readonly field: string;
    };
}

export function untrustedText(
    value: unknown,
    providerId: string,
    resourceId: string,
    field: string,
): UntrustedExternalText {
    return {
        trust: "untrusted",
        value: typeof value === "string" ? value : "",
        source: { providerId, resourceId, field },
    };
}

/** An absolute instant accompanied by the timezone used to interpret/display it. */
export interface ProviderDateTime {
    readonly date: Date;
    readonly iso: string;
    readonly timeZone: string;
    readonly allDay?: boolean;
}

export function providerDateTime(
    value: Date | string,
    timeZone: string,
    allDay = false,
): ProviderDateTime {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

    if (!Number.isFinite(date.getTime())) {
        throw new TypeError(`Data absoluta inválida: ${String(value)}`);
    }

    if (!timeZone.trim()) {
        throw new TypeError("Timezone é obrigatório para datas de providers.");
    }

    return {
        date,
        iso: date.toISOString(),
        timeZone,
        ...(allDay ? { allDay: true } : {}),
    };
}

export interface Page<T> {
    readonly items: readonly T[];
    readonly nextPageToken?: string;
}

export interface ExternalSourceReference {
    /** Provider metadata is external data and cannot authorize an action. */
    readonly trust: "untrusted";
    readonly provider: string;
    readonly type: string;
    readonly resourceId: string;
    readonly threadId?: string;
    readonly url?: string;
    readonly metadata?: Readonly<Record<string, string>>;
}
