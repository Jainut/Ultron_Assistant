import type { JsonSchema } from "./tool.ts";

export interface SchemaValidationResult {
    readonly valid: boolean;
    readonly errors: readonly string[];
}

/** Validador intencionalmente pequeno para o subconjunto usado pelas tools. */
export function validateToolInput(
    schema: JsonSchema,
    input: unknown,
): SchemaValidationResult {
    const errors: string[] = [];
    validateValue(schema, input, "$", errors);
    return { valid: errors.length === 0, errors };
}

function validateValue(
    schema: Record<string, unknown>,
    value: unknown,
    path: string,
    errors: string[],
): void {
    if (Array.isArray(schema.anyOf)) {
        const matches = schema.anyOf.some(candidate => {
            if (!isRecord(candidate)) return false;
            const candidateErrors: string[] = [];
            validateValue(candidate, value, path, candidateErrors);
            return candidateErrors.length === 0;
        });
        if (!matches) errors.push(`${path} não corresponde a nenhum formato permitido.`);
        return;
    }

    const type = typeof schema.type === "string" ? schema.type : undefined;

    if (type === "object") {
        if (!isRecord(value)) {
            errors.push(`${path} deve ser um objeto.`);
            return;
        }
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required)
            ? schema.required.filter((item): item is string => typeof item === "string")
            : [];
        for (const key of required) {
            if (!(key in value) || value[key] === undefined || value[key] === null) {
                errors.push(`${path}.${key} é obrigatório.`);
            }
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(key in properties)) errors.push(`${path}.${key} não é permitido.`);
            }
        }
        for (const [key, childSchema] of Object.entries(properties)) {
            if (key in value && value[key] !== undefined && isRecord(childSchema)) {
                validateValue(childSchema, value[key], `${path}.${key}`, errors);
            }
        }
        return;
    }

    if (type === "array") {
        if (!Array.isArray(value)) {
            errors.push(`${path} deve ser uma lista.`);
            return;
        }
        if (typeof schema.minItems === "number" && value.length < schema.minItems) {
            errors.push(`${path} deve possuir ao menos ${schema.minItems} item(ns).`);
        }
        if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
            errors.push(`${path} deve possuir no máximo ${schema.maxItems} item(ns).`);
        }
        if (isRecord(schema.items)) {
            value.forEach((item, index) => validateValue(schema.items as Record<string, unknown>, item, `${path}[${index}]`, errors));
        }
        return;
    }

    if (type === "string" && typeof value !== "string") {
        errors.push(`${path} deve ser texto.`);
        return;
    }
    if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
        errors.push(`${path} deve ser um número finito.`);
        return;
    }
    if (type === "integer" && (!Number.isInteger(value))) {
        errors.push(`${path} deve ser um número inteiro.`);
        return;
    }
    if (type === "boolean" && typeof value !== "boolean") {
        errors.push(`${path} deve ser booleano.`);
        return;
    }
    if (type === "null" && value !== null) {
        errors.push(`${path} deve ser nulo.`);
        return;
    }

    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push(`${path} possui valor inválido.`);
    }
    if (typeof value === "number") {
        if (typeof schema.minimum === "number" && value < schema.minimum) {
            errors.push(`${path} deve ser no mínimo ${schema.minimum}.`);
        }
        if (typeof schema.maximum === "number" && value > schema.maximum) {
            errors.push(`${path} deve ser no máximo ${schema.maximum}.`);
        }
    }
    if (typeof value === "string" && typeof schema.pattern === "string") {
        try {
            if (!new RegExp(schema.pattern).test(value)) {
                errors.push(`${path} não corresponde ao formato esperado.`);
            }
        } catch {
            errors.push(`${path} usa um padrão interno inválido.`);
        }
    }
    if (typeof value === "string") {
        if (typeof schema.minLength === "number" && value.length < schema.minLength) {
            errors.push(`${path} é curto demais.`);
        }
        if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
            errors.push(`${path} é longo demais.`);
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
