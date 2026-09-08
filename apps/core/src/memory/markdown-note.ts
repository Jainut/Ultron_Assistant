import path from "node:path";
import { parseDocument } from "yaml";

export type NoteProperty =
    string | number | boolean | null | Array<string | number | boolean | null>;
export interface MarkdownNote {
    id: string;
    title: string;
    aliases: string[];
    tags: string[];
    properties: Record<string, NoteProperty>;
    links: string[];
    text: string;
    propertiesValid: boolean;
}

export function normalizeNoteText(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}

export function cleanNoteText(text: string): string {
    // Notes may be shown in CMD; do not allow terminal escape/control sequences.
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

const scalar = (value: unknown): value is string | number | boolean | null =>
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
const strings = (value: NoteProperty | undefined): string[] =>
    (Array.isArray(value) ? value : [value])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);

/** YAML is data only. No custom tags, aliases, nested executable constructs or templates. */
export function parseMarkdownNote(id: string, markdown: string): MarkdownNote {
    let body = cleanNoteText(markdown.replace(/^\uFEFF/, ""));
    let properties: Record<string, NoteProperty> = {};
    let propertiesValid = true;
    const header = body.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
    if (header) {
        body = body.slice(header[0].length);
        try {
            if (header[1]!.length > 16_384) throw new Error("Properties too large");
            const doc = parseDocument(header[1]!, {
                schema: "core",
                version: "1.2",
                uniqueKeys: true,
                stringKeys: true,
                resolveKnownTags: false,
                prettyErrors: false,
                logLevel: "silent",
            });
            if (doc.errors.length || doc.warnings.length) throw new Error("Invalid properties");
            const values: unknown = doc.toJS({ mapAsMap: true, maxAliasCount: 0 });
            if (values !== null && !(values instanceof Map))
                throw new Error("Expected properties map");
            const entries: Array<[string, NoteProperty]> = [];
            for (const [key, value] of values ?? []) {
                if (entries.length >= 100) break;
                if (
                    typeof key !== "string" ||
                    ["__proto__", "constructor", "prototype"].includes(key)
                )
                    continue;
                if (scalar(value))
                    entries.push([
                        cleanNoteText(key),
                        typeof value === "string" ? cleanNoteText(value).slice(0, 2048) : value,
                    ]);
                else if (Array.isArray(value) && value.every(scalar))
                    entries.push([
                        cleanNoteText(key),
                        value
                            .slice(0, 100)
                            .map((item) =>
                                typeof item === "string"
                                    ? cleanNoteText(item).slice(0, 2048)
                                    : item,
                            ),
                    ]);
            }
            properties = Object.fromEntries(entries);
        } catch {
            propertiesValid = false;
        }
    }
    // Fenced examples, inline code and Obsidian/HTML comments are not graph edges.
    const prose = body
        .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, "")
        .replace(/`+[^`\n]*`+/g, "")
        .replace(/%%[\s\S]*?%%|<!--[\s\S]*?-->/g, "");
    const propertyText = Object.values(properties)
        .flat()
        .filter((item) => typeof item === "string")
        .join("\n");
    const links = new Set<string>();
    for (const match of `${prose}\n${propertyText}`.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
        links.add(match[1]!.split("|")[0]!.trim());
    }
    for (const match of prose.matchAll(/(?<!!)\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
        try {
            const link = decodeURIComponent(match[1]!);
            if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(link) && /\.md(?:#|$)/i.test(link))
                links.add(link);
        } catch {
            /* Invalid percent encoding is not a usable graph edge. */
        }
    }
    const tags = new Set(
        strings(properties.tags).map((tag) => tag.replace(/^#/, "").toLowerCase()),
    );
    for (const match of prose.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
        if (!/^\d+$/.test(match[1]!)) tags.add(match[1]!.toLowerCase());
    }
    const heading = prose.match(/^#\s+(.+)$/m)?.[1]?.trim();
    return {
        id,
        title: (typeof properties.title === "string"
            ? properties.title
            : heading || path.posix.basename(id, ".md")
        ).slice(0, 240),
        aliases: strings(properties.aliases).slice(0, 50),
        tags: [...tags].slice(0, 100),
        properties,
        links: [...links].slice(0, 300),
        text: body.slice(0, 32_768),
        propertiesValid,
    };
}
