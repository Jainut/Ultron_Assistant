import type { FetchTransport } from "../../security/oauth2-desktop.ts";
import type {
    ComposeMailInput,
    ListMailOptions,
    MailAddress,
    MailBodyPart,
    MailDraft,
    MailMessage,
    MailMessageSummary,
    MailProvider,
    MailSendResult,
    MailThread,
    SearchMailOptions,
} from "../mail-provider.ts";
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
    type Page,
    type UntrustedExternalText,
} from "../types.ts";
import {
    GoogleApiClient,
    type AccessTokenSource,
} from "./google-api-client.ts";

const PROVIDER_ID = "google.gmail";
const GMAIL_BASE_URL = "https://gmail.googleapis.com/gmail/v1/";

interface GmailHeader {
    name?: string;
    value?: string;
}

interface GmailPayload {
    mimeType?: string;
    headers?: GmailHeader[];
    body?: { data?: string };
    parts?: GmailPayload[];
}

interface GmailMessageResource {
    id?: string;
    threadId?: string;
    labelIds?: string[];
    snippet?: string;
    internalDate?: string;
    payload?: GmailPayload;
}

interface GmailMessageListResource {
    messages?: Array<{ id?: string; threadId?: string }>;
    nextPageToken?: string;
}

interface GmailThreadResource {
    id?: string;
    snippet?: string;
    messages?: GmailMessageResource[];
}

interface GmailDraftResource {
    id?: string;
    message?: GmailMessageResource;
}

export interface GmailProviderOptions {
    readonly oauth: AccessTokenSource;
    readonly transport?: FetchTransport;
    readonly userId?: string;
    readonly timeZone?: string;
}

export class GmailProvider implements MailProvider {
    readonly id = PROVIDER_ID;
    readonly kind = "mail" as const;
    readonly displayName = "Gmail";

    private readonly api: GoogleApiClient;
    private readonly userId: string;
    private readonly timeZone: string;

    constructor(options: GmailProviderOptions) {
        this.api = new GoogleApiClient(
            this.id,
            GMAIL_BASE_URL,
            options.oauth,
            options.transport,
        );
        this.userId = options.userId?.trim() || "me";
        this.timeZone = options.timeZone?.trim()
            || Intl.DateTimeFormat().resolvedOptions().timeZone
            || "UTC";
    }

    async healthCheck(context?: ProviderRequestContext): Promise<ProviderHealth> {
        await this.api.request(`users/${encodeURIComponent(this.userId)}/profile`, {
            signal: context?.signal,
        });
        return { providerId: this.id, status: "ready", checkedAt: new Date() };
    }

    async listMessages(options: ListMailOptions = {}): Promise<Page<MailMessageSummary>> {
        return await this.searchMessages(options);
    }

    async searchMessages(options: SearchMailOptions): Promise<Page<MailMessageSummary>> {
        const maxResults = clamp(options.maxResults ?? 20, 1, 100);
        const query = buildGmailQuery(options);
        const resource = await this.api.request<GmailMessageListResource>(
            `users/${encodeURIComponent(this.userId)}/messages`,
            {
                query: {
                    maxResults,
                    pageToken: options.pageToken,
                    q: query || undefined,
                    labelIds: options.labelIds,
                },
                signal: options.signal,
            },
        );

        const messages = await Promise.all((resource.messages ?? [])
            .filter((message): message is { id: string; threadId?: string } => (
                typeof message.id === "string"
            ))
            .map(message => this.getMessageSummary(message.id, options.signal)));

        return {
            items: messages,
            nextPageToken: resource.nextPageToken,
        };
    }

    async getMessage(
        messageId: string,
        context?: ProviderRequestContext,
    ): Promise<MailMessage> {
        validateResourceId(messageId, "email");
        const resource = await this.api.request<GmailMessageResource>(
            `users/${encodeURIComponent(this.userId)}/messages/${encodeURIComponent(messageId)}`,
            {
                query: { format: "full" },
                signal: context?.signal,
            },
        );
        return parseGmailMessage(resource, this.id, this.timeZone);
    }

    async getThread(
        threadId: string,
        context?: ProviderRequestContext,
    ): Promise<MailThread> {
        validateResourceId(threadId, "thread");
        const resource = await this.api.request<GmailThreadResource>(
            `users/${encodeURIComponent(this.userId)}/threads/${encodeURIComponent(threadId)}`,
            {
                query: { format: "full" },
                signal: context?.signal,
            },
        );
        const id = resource.id ?? threadId;
        return {
            id,
            messages: (resource.messages ?? []).map(message => (
                parseGmailMessage(message, this.id, this.timeZone)
            )),
            snippet: untrustedText(resource.snippet, this.id, id, "snippet"),
        };
    }

    async markAsRead(
        messageId: string,
        context?: ProviderRequestContext,
    ): Promise<void> {
        validateResourceId(messageId, "email");
        await this.api.request(
            `users/${encodeURIComponent(this.userId)}/messages/${encodeURIComponent(messageId)}/modify`,
            {
                method: "POST",
                body: { removeLabelIds: ["UNREAD"] },
                signal: context?.signal,
            },
        );
    }

    async createDraft(
        input: ComposeMailInput,
        context?: ProviderRequestContext,
    ): Promise<MailDraft> {
        validateComposeInput(input);
        const resource = await this.api.request<GmailDraftResource>(
            `users/${encodeURIComponent(this.userId)}/drafts`,
            {
                method: "POST",
                body: {
                    message: {
                        raw: encodeMimeMessage(input),
                        ...(input.threadId ? { threadId: input.threadId } : {}),
                    },
                },
                signal: context?.signal,
            },
        );

        if (!resource.id) {
            throw new ProviderValidationError(this.id, "O Gmail não retornou o ID do rascunho.");
        }
        return {
            id: resource.id,
            messageId: resource.message?.id,
            threadId: resource.message?.threadId,
        };
    }

    async sendMessage(
        input: ComposeMailInput,
        confirmation: UserConfirmation,
        context?: ProviderRequestContext,
    ): Promise<MailSendResult> {
        requireUserConfirmation(this.id, confirmation, "mail.send");
        validateComposeInput(input);
        const resource = await this.api.request<GmailMessageResource>(
            `users/${encodeURIComponent(this.userId)}/messages/send`,
            {
                method: "POST",
                body: {
                    raw: encodeMimeMessage(input),
                    ...(input.threadId ? { threadId: input.threadId } : {}),
                },
                signal: context?.signal,
            },
        );
        if (!resource.id) {
            throw new ProviderValidationError(this.id, "O Gmail não confirmou o aceite do envio.");
        }
        return { id: resource.id, threadId: resource.threadId, accepted: true };
    }

    private async getMessageSummary(
        messageId: string,
        signal?: AbortSignal,
    ): Promise<MailMessageSummary> {
        const resource = await this.api.request<GmailMessageResource>(
            `users/${encodeURIComponent(this.userId)}/messages/${encodeURIComponent(messageId)}`,
            {
                query: { format: "metadata" },
                signal,
            },
        );
        return parseGmailSummary(resource, this.id, this.timeZone);
    }
}

function parseGmailMessage(
    resource: GmailMessageResource,
    providerId: string,
    timeZone: string,
): MailMessage {
    const summary = parseGmailSummary(resource, providerId, timeZone);
    const headers = headerMap(resource.payload?.headers);
    const markedHeaders: Record<string, UntrustedExternalText> = {};
    for (const [name, value] of headers) {
        markedHeaders[name] = untrustedText(value, providerId, summary.id, `header.${name}`);
    }

    return {
        ...summary,
        to: parseAddresses(headers.get("to"), providerId, summary.id, "to"),
        cc: parseAddresses(headers.get("cc"), providerId, summary.id, "cc"),
        headers: markedHeaders,
        body: extractBodyParts(resource.payload, providerId, summary.id),
    };
}

function parseGmailSummary(
    resource: GmailMessageResource,
    providerId: string,
    timeZone: string,
): MailMessageSummary {
    const id = resource.id ?? "unknown";
    const headers = headerMap(resource.payload?.headers);
    const received = parseReceivedAt(headers.get("date"), resource.internalDate);
    return {
        id,
        threadId: resource.threadId ?? id,
        subject: untrustedText(headers.get("subject"), providerId, id, "subject"),
        from: parseAddresses(headers.get("from"), providerId, id, "from"),
        receivedAt: providerDateTime(received, timeZone),
        unread: resource.labelIds?.includes("UNREAD") ?? false,
        labels: [...(resource.labelIds ?? [])],
        snippet: untrustedText(resource.snippet, providerId, id, "snippet"),
    };
}

function extractBodyParts(
    payload: GmailPayload | undefined,
    providerId: string,
    resourceId: string,
): MailBodyPart[] {
    if (!payload) return [];
    const output: MailBodyPart[] = [];

    const visit = (part: GmailPayload): void => {
        const mimeType = part.mimeType ?? "application/octet-stream";
        if (part.body?.data && (mimeType === "text/plain" || mimeType === "text/html")) {
            output.push({
                mimeType,
                content: untrustedText(
                    decodeBase64Url(part.body.data),
                    providerId,
                    resourceId,
                    `body.${mimeType}`,
                ),
            });
        }
        for (const child of part.parts ?? []) visit(child);
    };
    visit(payload);
    return output;
}

function headerMap(headers: readonly GmailHeader[] | undefined): Map<string, string> {
    const result = new Map<string, string>();
    for (const header of headers ?? []) {
        if (typeof header.name !== "string" || typeof header.value !== "string") continue;
        result.set(header.name.toLowerCase(), header.value);
    }
    return result;
}

function parseAddresses(
    value: string | undefined,
    providerId: string,
    resourceId: string,
    field: string,
): MailAddress[] {
    if (!value) return [];
    const addresses: MailAddress[] = [];
    for (const item of splitAddressHeader(value)) {
        const match = item.trim().match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
        const name = match?.[1]?.trim();
        const address = (match?.[2] ?? item).trim();
        addresses.push({
            ...(name ? { name: untrustedText(name, providerId, resourceId, `${field}.name`) } : {}),
            address: untrustedText(address, providerId, resourceId, `${field}.address`),
        });
    }
    return addresses;
}

function splitAddressHeader(value: string): string[] {
    const output: string[] = [];
    let quoted = false;
    let angleDepth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
        else if (!quoted && character === "<") angleDepth += 1;
        else if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);
        else if (!quoted && angleDepth === 0 && character === ",") {
            output.push(value.slice(start, index));
            start = index + 1;
        }
    }
    output.push(value.slice(start));
    return output.filter(item => item.trim().length > 0);
}

function parseReceivedAt(headerDate: string | undefined, internalDate: string | undefined): Date {
    const header = headerDate ? new Date(headerDate) : undefined;
    if (header && Number.isFinite(header.getTime())) return header;
    const timestamp = Number(internalDate);
    return Number.isFinite(timestamp) ? new Date(timestamp) : new Date(0);
}

function buildGmailQuery(options: SearchMailOptions): string {
    const fragments = [options.query?.trim()].filter(Boolean) as string[];
    if (options.unreadOnly) fragments.push("is:unread");
    if (options.from?.trim()) fragments.push(`from:${quoteGmailQuery(options.from.trim())}`);
    if (options.subject?.trim()) fragments.push(`subject:${quoteGmailQuery(options.subject.trim())}`);
    if (options.newerThan) {
        fragments.push(`after:${Math.floor(options.newerThan.date.getTime() / 1_000)}`);
    }
    return fragments.join(" ");
}

function quoteGmailQuery(value: string): string {
    return `"${value.replace(/["\\]/g, character => `\\${character}`)}"`;
}

function validateComposeInput(input: ComposeMailInput): void {
    if (input.to.length === 0) {
        throw new ProviderValidationError(PROVIDER_ID, "Ao menos um destinatário é obrigatório.");
    }
    for (const address of [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]) {
        if (!address.trim() || /[\r\n]/.test(address)) {
            throw new ProviderValidationError(PROVIDER_ID, "Endereço de email inválido.");
        }
    }
    for (const header of [input.subject, input.inReplyToMessageId, input.threadId]) {
        if (header && /[\r\n]/.test(header)) {
            throw new ProviderValidationError(PROVIDER_ID, "Cabeçalho de email inválido.");
        }
    }
}

function encodeMimeMessage(input: ComposeMailInput): string {
    const headers = [
        `To: ${input.to.join(", ")}`,
        ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
        ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
        `Subject: =?UTF-8?B?${Buffer.from(input.subject, "utf8").toString("base64")}?=`,
        ...(input.inReplyToMessageId ? [`In-Reply-To: ${input.inReplyToMessageId}`] : []),
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
    ];
    const encodedBody = Buffer.from(input.text, "utf8").toString("base64")
        .match(/.{1,76}/g)?.join("\r\n") ?? "";
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${encodedBody}`, "utf8")
        .toString("base64url");
}

function decodeBase64Url(value: string): string {
    try {
        return Buffer.from(value, "base64url").toString("utf8");
    } catch {
        return "";
    }
}

function validateResourceId(value: string, resource: string): void {
    if (!value.trim()) {
        throw new ProviderValidationError(PROVIDER_ID, `ID de ${resource} obrigatório.`);
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    if (!Number.isFinite(value)) return minimum;
    return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
