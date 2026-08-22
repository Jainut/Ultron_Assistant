export type ProviderKind = "mail" | "tasks" | "calendar";

export interface ProviderIdentity {
    readonly id: string;
    readonly kind: ProviderKind;
    readonly displayName: string;
}

export interface ProviderRequestContext {
    signal?: AbortSignal;
}

export interface ProviderHealth {
    providerId: string;
    status: "ready" | "degraded" | "unavailable";
    checkedAt: Date;
    message?: string;
}

export type ProviderErrorCode =
    | "authentication"
    | "authorization"
    | "rate_limit"
    | "not_found"
    | "conflict"
    | "validation"
    | "network"
    | "cancelled"
    | "remote_error";

export interface ProviderErrorOptions {
    providerId: string;
    code: ProviderErrorCode;
    status?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    cause?: unknown;
}

/**
 * An error safe to propagate through the provider boundary. Its message must
 * never contain request headers, OAuth tokens, client secrets, or raw bodies.
 */
export class ProviderError extends Error {
    readonly providerId: string;
    readonly code: ProviderErrorCode;
    readonly status?: number;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;

    constructor(message: string, options: ProviderErrorOptions) {
        super(message, { cause: options.cause });
        this.name = "ProviderError";
        this.providerId = options.providerId;
        this.code = options.code;
        this.status = options.status;
        this.retryable = options.retryable ?? false;
        this.retryAfterMs = options.retryAfterMs;
    }
}
export class ProviderAuthenticationError extends ProviderError {
    constructor(providerId: string, cause?: unknown) {
        super(`O provider ${providerId} precisa ser autenticado novamente.`, {
            providerId,
            code: "authentication",
            status: 401,
            cause,
        });
        this.name = "ProviderAuthenticationError";
    }
}

export class ProviderPermissionError extends ProviderError {
    constructor(providerId: string, cause?: unknown) {
        super(`O provider ${providerId} não possui permissão para esta operação.`, {
            providerId,
            code: "authorization",
            status: 403,
            cause,
        });
        this.name = "ProviderPermissionError";
    }
}

export class ProviderNotFoundError extends ProviderError {
    constructor(providerId: string, resource: string, cause?: unknown) {
        super(`${resource} não foi encontrado no provider ${providerId}.`, {
            providerId,
            code: "not_found",
            status: 404,
            cause,
        });
        this.name = "ProviderNotFoundError";
    }
}

export class ProviderConflictError extends ProviderError {
    readonly conflicts: readonly unknown[];

    constructor(
        providerId: string,
        message: string,
        conflicts: readonly unknown[] = [],
        cause?: unknown,
    ) {
        super(message, {
            providerId,
            code: "conflict",
            status: 409,
            cause,
        });
        this.name = "ProviderConflictError";
        this.conflicts = conflicts;
    }
}

export class ProviderValidationError extends ProviderError {
    constructor(providerId: string, message: string, cause?: unknown) {
        super(message, {
            providerId,
            code: "validation",
            cause,
        });
        this.name = "ProviderValidationError";
    }
}

export interface UserConfirmation {
    readonly confirmedByUser: true;
    readonly confirmedAt: Date;
    readonly action: string;
}

export function requireUserConfirmation(
    providerId: string,
    confirmation: UserConfirmation | undefined,
    expectedAction: string,
): void {
    if (
        confirmation?.confirmedByUser !== true
        || confirmation.action !== expectedAction
        || !Number.isFinite(confirmation.confirmedAt.getTime())
    ) {
        throw new ProviderValidationError(
            providerId,
            `Confirmação explícita é obrigatória para ${expectedAction}.`,
        );
    }
}
