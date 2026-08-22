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

export interface MailAddress {
    readonly name?: UntrustedExternalText;
    readonly address: UntrustedExternalText;
}

export interface MailMessageSummary {
    readonly id: string;
    readonly threadId: string;
    readonly subject: UntrustedExternalText;
    readonly from: readonly MailAddress[];
    readonly receivedAt: ProviderDateTime;
    readonly unread: boolean;
    readonly labels: readonly string[];
    readonly snippet: UntrustedExternalText;
}

export interface MailBodyPart {
    readonly mimeType: string;
    readonly content: UntrustedExternalText;
}

export interface MailMessage extends MailMessageSummary {
    readonly to: readonly MailAddress[];
    readonly cc: readonly MailAddress[];
    readonly headers: Readonly<Record<string, UntrustedExternalText>>;
    readonly body: readonly MailBodyPart[];
}

export interface MailThread {
    readonly id: string;
    readonly messages: readonly MailMessage[];
    readonly snippet: UntrustedExternalText;
}

export interface ListMailOptions extends ProviderRequestContext {
    readonly unreadOnly?: boolean;
    readonly maxResults?: number;
    readonly pageToken?: string;
    readonly newerThan?: ProviderDateTime;
    readonly labelIds?: readonly string[];
}

export interface SearchMailOptions extends ListMailOptions {
    readonly query?: string;
    readonly from?: string;
    readonly subject?: string;
}

export interface ComposeMailInput {
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly bcc?: readonly string[];
    readonly subject: string;
    readonly text: string;
    readonly inReplyToMessageId?: string;
    readonly threadId?: string;
}

export interface MailDraft {
    readonly id: string;
    readonly messageId?: string;
    readonly threadId?: string;
}

export interface MailSendResult {
    readonly id: string;
    readonly threadId?: string;
    readonly accepted: true;
}

export interface MailProvider extends ProviderIdentity {
    readonly kind: "mail";

    listMessages(options?: ListMailOptions): Promise<Page<MailMessageSummary>>;
    searchMessages(options: SearchMailOptions): Promise<Page<MailMessageSummary>>;
    getMessage(messageId: string, context?: ProviderRequestContext): Promise<MailMessage>;
    getThread(threadId: string, context?: ProviderRequestContext): Promise<MailThread>;
    markAsRead(messageId: string, context?: ProviderRequestContext): Promise<void>;
    createDraft(input: ComposeMailInput, context?: ProviderRequestContext): Promise<MailDraft>;
    sendMessage(
        input: ComposeMailInput,
        confirmation: UserConfirmation,
        context?: ProviderRequestContext,
    ): Promise<MailSendResult>;
}
