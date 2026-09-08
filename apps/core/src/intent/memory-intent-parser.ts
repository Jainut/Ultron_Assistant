/** Explicit note operations only; quoted note content never re-enters this parser. */
export function parseMemoryIntent(input: string): {
    name: string;
    input: Record<string, unknown>;
    category: "memory";
    confidence: number;
    serialKey: string;
} | null {
    const text = input
        .trim()
        .replace(/^ultron[, ]*/i, "")
        .replace(/[.!?]+$/, "");
    const match = (expression: RegExp) => text.match(expression)?.[1]?.trim();
    let name: string | undefined;
    let args: Record<string, unknown> = {};
    const search =
        match(
            /^(?:procura|procure|pesquisa|pesquise|busca|busque|encontra|encontre) (?:nas? minhas? notas|nas? notas|no obsidian) (?:sobre |por |a respeito de )?(.+)$/i,
        ) ??
        match(
            /^(?:procura|procure|pesquisa|pesquise|busca|busque|encontra|encontre) (?:as? )?(?:notas|anotações) (?:sobre|de|a respeito de) (.+)$/i,
        );
    const read = match(
        /^(?:lê|le|leia|ler|resuma|resume|mostra|mostre) (?:a )?(?:nota|anotação) (?:chamada )?(.+)$/i,
    );
    const connections = match(
        /^(?:mostra|mostre|lista|liste|quais são) (?:as? |os? )?(?:conexões|links|backlinks) (?:da? )?(?:nota )?(.+)$/i,
    );
    if (/^(?:status|estado) (?:do )?(?:obsidian|índice de notas|indice de notas)$/i.test(text))
        name = "memory.status";
    else if (
        /^(?:lê|le|leia|resuma|resume|mostra|mostre) (?:essa|esta|aquela) (?:nota|anotação)$/i.test(
            text,
        )
    )
        name = "memory.read";
    else if (search) {
        name = "memory.search";
        args = { query: search };
    } else if (read) {
        name = "memory.read";
        args = { note: read };
    } else if (connections) {
        name = "memory.connections";
        args = /^d?(?:essa|esta|aquela)(?: nota)?$/i.test(connections) ? {} : { note: connections };
    }
    if (name === "memory.read" && /^(?:resuma|resume)\b/i.test(text)) name = "memory.summarize";
    return name
        ? { name, input: args, category: "memory", confidence: 0.99, serialKey: "memory-context" }
        : null;
}
