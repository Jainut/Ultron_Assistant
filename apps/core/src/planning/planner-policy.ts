const MAIL_READ_TOOLS = ["mail.list", "mail.search", "mail.read", "mail.thread"] as const;

export interface PlannerPolicy {
    readonly staged: boolean;
    /** Mail-only clause that may be routed locally before consulting the LLM. */
    readonly sourceRequest?: string;
    readonly initialToolNames?: readonly string[];
    readonly followupToolNames: readonly string[];
    readonly goalToolNames: readonly string[];
    /** At least one of these must succeed before a derived mutation is offered. */
    readonly sourceReadyToolNames: readonly string[];
}

function normalize(value: string): string {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

function extractMailSourceRequest(input: string): string | undefined {
    const goalBoundary = /(?:\b(?:e|depois)\s*,?\s*|[;,]\s*)(?:(?:com\s+base\s+(?:nele|nisso|nesse\s+(?:email|e-mail)|neste\s+(?:email|e-mail))\s*,?\s*)?)(?=(?:cria|crie|criar|adiciona|adicione|adicionar|inclui|inclua|incluir|coloca|coloque|marca|marque|marcar|agenda|agende|agendar)\b)/iu.exec(
        input,
    );
    if (!goalBoundary) return undefined;

    const source = input.slice(0, goalBoundary.index).trim();
    return /\b(?:email|emails|e-mail|e-mails|gmail|mensagem|remetente|assunto)\b/iu.test(source)
        ? source
        : undefined;
}

/**
 * Grants are derived exclusively from the user's original utterance. Tool
 * output cannot add a capability to later planning rounds.
 */
export function createPlannerPolicy(input: string): PlannerPolicy {
    const text = normalize(input);
    const mentionsMail =
        /\b(?:email|emails|e-mail|e-mails|gmail|mensagem|remetente|assunto)\b/.test(text);
    const asksMailRead =
        /\b(?:veja|ver|leia|ler|mostra|mostre|procura|procure|busca|busque|encontra|encontre)\b/.test(
            text,
        );
    if (!mentionsMail || !asksMailRead) {
        return { staged: false, followupToolNames: [], goalToolNames: [], sourceReadyToolNames: [] };
    }

    const goals: string[] = [];
    const taskCreation =
        /\b(?:cria|crie|criar|adiciona|adicione|adicionar|inclui|inclua|incluir|coloca|coloque)\b[\s\S]*\b(?:tarefa|tasks?|to\s*do|pendencia)\b/.test(
            text,
        );
    const calendarCreation =
        /\b(?:coloca|coloque|adiciona|adicione|adicionar|marca|marque|marcar|agende|agendar|cria|crie|criar)\b[\s\S]*\b(?:agenda|calendario|evento|reuniao|entrevista|compromisso)\b/.test(
            text,
        ) || /(?:^|\be\s+)agenda\s+(?:a|o|uma|um)\s+(?:entrevista|reuniao|evento|compromisso)\b/.test(text);
    if (taskCreation) goals.push("task.create");
    if (calendarCreation) goals.push("calendar.create");
    if (!goals.length) {
        return { staged: false, followupToolNames: [], goalToolNames: [], sourceReadyToolNames: [] };
    }

    return {
        staged: true,
        sourceRequest: extractMailSourceRequest(input),
        initialToolNames: MAIL_READ_TOOLS,
        followupToolNames: [
            "mail.read",
            "mail.thread",
            // calendar.create already checks conflicts by default in the provider.
            ...(calendarCreation ? ["calendar.create"] : []),
            ...(taskCreation ? ["task.create"] : []),
        ],
        goalToolNames: goals,
        sourceReadyToolNames: ["mail.read", "mail.thread"],
    };
}

export function pendingPlannerGoals(
    policy: PlannerPolicy,
    successfulTools: ReadonlySet<string>,
): string[] {
    return policy.goalToolNames.filter((name) => !successfulTools.has(name));
}
