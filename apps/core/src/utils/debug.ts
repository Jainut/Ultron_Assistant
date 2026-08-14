export const debugEnabled = process.env.ULTRON_DEBUG === "1";

export function debugLog(...values: unknown[]): void {
    if (debugEnabled) {
        console.log(...values);
    }
}

export function serviceError(prefix: string, value: unknown): void {
    const message = String(value).trim();

    if (!message) {
        return;
    }

    if (debugEnabled || /\b(error|erro|fatal|traceback|exception)\b/i.test(message)) {
        console.error(`${prefix} ${message}`);
    }
}
