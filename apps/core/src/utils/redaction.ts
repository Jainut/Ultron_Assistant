const secretKey = /(?:token|secret|password|authorization|cookie|credential|code_verifier|client_secret)/i;
const privateContentKey = /^(?:text|body|html|notes|description|to|cc|bcc)$/i;

/** Produz somente um snapshot seguro para diagnóstico; nunca altera o valor. */
export function redactForLog(value: unknown, depth = 0): unknown {
    if (depth > 5) return "[TRUNCATED]";
    if (Array.isArray(value)) {
        return value.slice(0, 20).map(item => redactForLog(item, depth + 1));
    }
    if (!value || typeof value !== "object") return value;

    const record = value as Record<string, unknown>;
    if (record.trust === "untrusted" || record.trust === "untrusted-derived") {
        return { trust: record.trust, value: "[EXTERNAL_CONTENT_REDACTED]" };
    }

    return Object.fromEntries(Object.entries(record).map(([key, item]) => {
        if (secretKey.test(key)) return [key, "[REDACTED]"];
        if (privateContentKey.test(key)) return [key, "[PRIVATE_CONTENT_REDACTED]"];
        return [key, redactForLog(item, depth + 1)];
    }));
}
