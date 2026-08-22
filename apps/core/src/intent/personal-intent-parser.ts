import type { OperationalContextSnapshot, OperationalReference } from "../context/operational-context.ts";
import {
    PtBrTemporalContext,
    type TemporalResolution,
} from "../time/pt-br-temporal-context.ts";

export type PersonalIntentCategory =
    | "mail"
    | "tasks"
    | "calendar"
    | "automation"
    | "information";

/** A registry-ready action produced without an LLM or provider request. */
export interface PersonalIntentAction {
    readonly name: string;
    readonly input: Record<string, unknown>;
    readonly category: PersonalIntentCategory;
    readonly confidence: number;
    readonly serialKey?: string;
}

export interface PersonalIntentParserOptions {
    /** Injectable temporal resolver. Its clock should be injected in deterministic tests. */
    readonly temporalContext?: PtBrTemporalContext;
    /** Snapshot only; parsing never mutates operational context. */
    readonly operationalContext?: Readonly<OperationalContextSnapshot>;
    /** Used only when the user supplies a start time but no duration. Defaults to 60 minutes. */
    readonly defaultEventDurationMinutes?: number;
}

const ACTIVE_MAIL_REFERENCE = /\b(?:esse|este|aquele|nesse|neste|naquele|o ultimo|o atual)\s+(?:e-?mail|email)\b/;
const ACTIVE_TASK_REFERENCE = /\b(?:essa|esta|aquela|nessa|nesta|naquela|a ultima|a atual)\s+tarefa\b/;
const ACTIVE_EVENT_REFERENCE = /\b(?:essa|esta|aquela|nessa|nesta|naquela|a ultima|a atual)\s+(?:reuniao|evento|agenda|compromisso)\b/;

/**
 * Conservative pt-BR parser for personal information tools.
 *
 * It returns null whenever a required title, query, date or exact start time is
 * absent. External data is never inspected and no provider/network call occurs.
 */
export class PersonalIntentParser {
    private readonly temporal: PtBrTemporalContext;
    private readonly context: Readonly<OperationalContextSnapshot>;
    private readonly eventDurationMs: number;

    constructor(options: PersonalIntentParserOptions = {}) {
        this.temporal = options.temporalContext ?? new PtBrTemporalContext();
        this.context = options.operationalContext ?? {};

        const duration = options.defaultEventDurationMinutes ?? 60;
        if (!Number.isFinite(duration) || duration <= 0 || duration > 24 * 60) {
            throw new RangeError("A duração padrão do evento deve ficar entre 1 minuto e 24 horas.");
        }
        this.eventDurationMs = Math.round(duration * 60_000);
    }

    parse(input: string): PersonalIntentAction | null {
        const source = stripWakeWord(input).trim();
        if (!source) return null;

        const text = normalize(source);
        const temporal = this.temporal.resolve(source);

        return this.parseGoogleConnection(text)
            ?? this.parsePersonalAutomation(source, text, temporal)
            ?? this.parseDailyBriefing(text, temporal)
            ?? this.parseNotifications(text)
            ?? this.parseTaskCreation(source, text, temporal)
            ?? this.parseTaskCompletion(source, text)
            ?? this.parseCalendarCreation(source, text, temporal)
            ?? this.parseCalendarConflict(text, temporal)
            ?? this.parseActiveCalendarAction(text)
            ?? this.parseMailAction(source, text)
            ?? this.parseTaskReadAction(source, text, temporal)
            ?? this.parseCalendarReadAction(source, text, temporal);
    }

    private parseGoogleConnection(text: string): PersonalIntentAction | null {
        if (!/\b(?:conecta|conecte|conectar|vincula|vincule|vincular|autoriza|autorize|autorizar)\b/.test(text)) {
            return null;
        }
        if (!/\b(?:conta\s+google|google|gmail)\b/.test(text)) return null;

        return action("google.connect", {}, "automation", 0.99, "provider:google");
    }

    private parsePersonalAutomation(
        source: string,
        text: string,
        temporal: TemporalResolution | null,
    ): PersonalIntentAction | null {
        const notificationVerb = /\b(?:me\s+)?(?:avisa|avise|avisar|notifica|notifique|notificar|lembra|lembre)\b/.test(text);
        const activeThreadId = typeof this.context.activeEmail?.metadata?.threadId === "string"
            ? this.context.activeEmail.metadata.threadId
            : undefined;

        if (
            notificationVerb
            && /\bse\s+(?:eles?|elas?)\s+(?:responder|responderem|responde)\b/.test(text)
            && activeThreadId
        ) {
            return action(
                "automation.createEmailWatch",
                { threadId: activeThreadId },
                "automation",
                0.98,
                `mail-watch:${activeThreadId}`,
            );
        }

        const watchesIncomingMail = notificationVerb
            && /\b(?:quando|se)\b/.test(text)
            && /\b(?:chegar|chegue|receber|receba|vier|entrar)\b/.test(text)
            && /\b(?:email|e-mail)\b/.test(text);
        if (watchesIncomingMail) {
            return action(
                "automation.createEmailWatch",
                extractEmailWatchFilters(source),
                "automation",
                0.97,
                "automation:email-watch",
            );
        }

        const leadMinutes = extractReminderLeadMinutes(text);
        if (
            notificationVerb
            && leadMinutes !== null
            && /\b(?:reuniao|reunioes|evento|eventos|compromisso|compromissos)\b/.test(text)
        ) {
            return action(
                "automation.createCalendarReminder",
                { leadMinutes },
                "automation",
                0.99,
                "automation:calendar-reminder",
            );
        }

        const recurring = /\b(?:todo\s+dia|todos\s+os\s+dias|diariamente)\b/.test(text);
        const asksBriefing = /\b(?:briefing|resumo|compromissos|agenda|tarefas|meu\s+dia)\b/.test(text)
            && /\b(?:diga|fale|mostra|mostre|avisa|avise|resumo|briefing)\b/.test(text);
        if (recurring && asksBriefing) {
            return action(
                "automation.createDailyBriefing",
                {
                    time: extractRecurringClock(text) ?? "08:00",
                    timeZone: temporal?.timeZone ?? "America/Sao_Paulo",
                },
                "automation",
                0.98,
                "automation:daily-briefing",
            );
        }

        return null;
    }

    private parseDailyBriefing(
        text: string,
        temporal: TemporalResolution | null,
    ): PersonalIntentAction | null {
        const asksBriefing = /\b(?:briefing|resumo\s+(?:do|da)\s+dia|como\s+(?:esta|vai)\s+(?:o\s+)?meu\s+dia)\b/.test(text)
            || /\bo\s+que\s+eu\s+tenho\s+(?:para|pra)\s+(?:hoje|amanha)\b/.test(text)
            || /\bquais\s+coisas?\s+(?:eu\s+)?tenho\s+(?:para|pra)\s+(?:hoje|amanha)\b/.test(text);
        if (!asksBriefing) return null;

        return action(
            "personal.dailyBriefing",
            temporal
                ? { at: temporal.range.startIso, timeZone: temporal.timeZone }
                : {},
            "information",
            0.98,
            "personal-context",
        );
    }

    private parseNotifications(text: string): PersonalIntentAction | null {
        const asksNotifications = /\b(?:aviso|avisos|notificacao|notificacoes|alerta|alertas)\b/.test(text)
            && (
                /\b(?:lista|liste|listar|mostra|mostre|mostrar|quais|ver|veja|tenho|tem)\b/.test(text)
                || /^(?:meus|minhas|os meus|as minhas)\b/.test(text)
            );
        if (!asksNotifications) return null;

        const pendingOnly = /\b(?:pendente|pendentes|novo|novos|nova|novas|nao lido|nao lidos|nao lida|nao lidas)\b/.test(text);
        return action(
            "notification.list",
            pendingOnly ? { status: "pending" } : {},
            "information",
            0.98,
            "notifications",
        );
    }

    private parseMailAction(source: string, text: string): PersonalIntentAction | null {
        const activeMail = ACTIVE_MAIL_REFERENCE.test(text)
            || /\b(?:email|e-mail)\s+(?:atual|aberto|selecionado)\b/.test(text);

        if (/\b(?:marca|marque|marcar)\b.*\b(?:email|e-mail)\b.*\b(?:como\s+)?lido\b/.test(text)
            || /\b(?:marca|marque|marcar)\b.*\b(?:como\s+)?lido\b.*\b(?:email|e-mail)\b/.test(text)) {
            if (!activeMail && !/\b(?:o|esse|este|aquele)\s+(?:email|e-mail)\b/.test(text)) return null;
            return action("mail.markRead", {}, "mail", 0.98, "personal-context");
        }

        if (/\b(?:resume|resuma|resumir|sintetiza|sintetize)\b/.test(text)) {
            if (/\b(?:essa|esta|aquela|a)\s+(?:conversa|thread)\b/.test(text)) {
                return action("mail.summarize", { wholeThread: true }, "mail", 0.97, "personal-context");
            }
            if (activeMail) {
                return action("mail.summarize", {}, "mail", 0.99, "personal-context");
            }
            return null;
        }

        if (/\b(?:leia|ler|abre|abra|abrir|mostra|mostre)\b/.test(text) && activeMail) {
            return action("mail.read", {}, "mail", 0.99, "personal-context");
        }

        const search = mailSearchInput(source, text);
        if (search) {
            return action("mail.search", search.input, "mail", search.confidence, "personal-context");
        }

        const mailReadVerb = /\b(?:lista|liste|listar|leia|ler|mostra|mostre|ver|veja)\b/.test(text);
        if (mailReadVerb && /\b(?:emails|email|e-mails|e-mail)\b/.test(text)) {
            const unreadOnly = /\b(?:novo|novos|nova|novas|nao\s+lido|nao\s+lidos|nao\s+lida|nao\s+lidas|pendentes?)\b/.test(text);
            return action("mail.list", unreadOnly ? { unreadOnly: true } : {}, "mail", unreadOnly ? 0.99 : 0.94);
        }

        return null;
    }

    private parseTaskCreation(
        source: string,
        text: string,
        temporal: TemporalResolution | null,
    ): PersonalIntentAction | null {
        const match = /^(?:cria|crie|criar|adiciona|adicione|adicionar|inclui|inclua|incluir)\s+(?:uma\s+)?tarefa\b/.exec(text);
        const reminder = /^(?:me\s+)?(?:lembra|lembre)\s+(?:de\s+)?/.exec(text);
        if (!match && !reminder) return null;

        const originalPrefix = match
            ? /^(?:cria|crie|criar|adiciona|adicione|adicionar|inclui|inclua|incluir)\s+(?:uma\s+)?tarefa\b/iu
            : /^(?:me\s+)?(?:lembra|lembre)\s+(?:de\s+)?/iu;
        let title = source.replace(originalPrefix, "").trim();
        title = title.replace(/^(?:para|pra)(?:\s+eu)?\s+/iu, "");
        title = stripTemporalExpression(title, temporal);
        title = cleanTitle(title);

        // This form requires semantic extraction from the active email body; a
        // deterministic parser must not fabricate the missing task title.
        if (/\b(?:o que|aquilo que)\s+(?:eu\s+)?(?:preciso|devo|tenho que)\b/.test(text)
            || /\bbasead[oa]\s+(?:nesse|neste|no)\s+(?:email|e-mail)\b/.test(text)) {
            return null;
        }
        if (!hasMeaningfulTitle(title)) return null;

        const taskInput: Record<string, unknown> = { title: sentenceCase(title) };
        if (temporal) {
            taskInput.due = temporal.instantIso ?? temporal.range.startIso;
            taskInput.timeZone = temporal.timeZone;
            taskInput.allDay = temporal.allDay;
        }
        if (ACTIVE_MAIL_REFERENCE.test(text)) {
            taskInput.useActiveEmail = true;
        }

        return action(
            "task.create",
            taskInput,
            "tasks",
            temporal ? 0.99 : 0.95,
            taskInput.useActiveEmail ? "personal-context" : undefined,
        );
    }

    private parseTaskCompletion(source: string, text: string): PersonalIntentAction | null {
        const isCompletion = /\b(?:conclui|conclua|concluir|finaliza|finalize|finalizar|completa|complete|completar)\b/.test(text)
            || /\bmarca(?:r|que)?\b.*\b(?:como\s+)?(?:concluida|concluido|feita|feito)\b/.test(text);
        if (!isCompletion || !/\b(?:tarefa|task)\b/.test(text)) return null;

        if (ACTIVE_TASK_REFERENCE.test(text)
            || /\b(?:tarefa|task)\s+(?:atual|aberta|selecionada)\b/.test(text)) {
            return action("task.complete", {}, "tasks", 0.99, "personal-context");
        }

        const id = /\b(?:tarefa|task)\s+(?:id|codigo)\s*[:#-]?\s*([a-z0-9_-]{3,})\b/.exec(text)?.[1];
        if (id) {
            return action("task.complete", { taskId: id }, "tasks", 0.99, `task:${id}`);
        }

        const requestedTitle = extractTaskCompletionTitle(source);
        const activeTask = this.context.activeTask;
        if (!requestedTitle || !activeTask?.id || !referenceMatches(activeTask, requestedTitle)) {
            return null;
        }

        return action(
            "task.complete",
            { taskId: activeTask.id },
            "tasks",
            0.96,
            `task:${activeTask.id}`,
        );
    }

    private parseTaskReadAction(
        source: string,
        text: string,
        temporal: TemporalResolution | null,
    ): PersonalIntentAction | null {
        const searchMatch = /^(?:procura|procure|procurar|busca|busque|buscar|pesquisa|pesquise|encontra|encontre)\s+(?:a\s+|uma\s+)?tarefa\s+(.+)$/iu.exec(source);
        if (searchMatch?.[1]) {
            const query = cleanQuery(stripTrailingPunctuation(searchMatch[1]));
            if (!query) return null;
            return action("task.search", { query }, "tasks", 0.96, "personal-context");
        }

        const listVerb = /\b(?:lista|liste|listar|mostra|mostre|mostrar|quais|ver|veja)\b/.test(text)
            || /^(?:minhas|as minhas)\s+(?:tarefas|pendencias|atividades)\b/.test(text);
        if (!listVerb || !/\b(?:tarefas|pendencias|afazeres|atividades)\b/.test(text)) return null;

        const input: Record<string, unknown> = {};
        if (temporal) {
            input.dueMin = temporal.range.startIso;
            input.dueMax = temporal.range.endExclusiveIso;
            input.timeZone = temporal.timeZone;
        }
        return action("task.list", input, "tasks", 0.96);
    }

    private parseCalendarCreation(
        source: string,
        text: string,
        temporal: TemporalResolution | null,
    ): PersonalIntentAction | null {
        const creation = /^(?:marca|marque|marcar|agenda|agende|agendar|cria|crie|criar|adiciona|adicione|adicionar)\b/.test(text);
        if (!creation || !/\b(?:reuniao|evento|compromisso|consulta|entrevista)\b/.test(text)) return null;

        // A calendar event needs an exact wall-clock start. A date or broad day
        // period alone is intentionally delegated to contextual interpretation.
        if (!temporal?.instantIso) return null;

        let summary = source.replace(
            /^(?:marca|marque|marcar|agenda|agende|agendar|cria|crie|criar|adiciona|adicione|adicionar)\s+/iu,
            "",
        );
        summary = summary.replace(/^(?:no\s+calendario|na\s+agenda)\s+/iu, "");
        summary = summary.replace(/^(?:um|uma)\s+/iu, "");
        summary = stripTemporalExpression(summary, temporal);
        summary = cleanTitle(summary);
        if (!hasMeaningfulTitle(summary)) return null;

        const start = new Date(temporal.instantIso);
        const end = new Date(start.getTime() + this.eventDurationMs);
        return action("calendar.create", {
            summary: sentenceCase(summary),
            start: start.toISOString(),
            end: end.toISOString(),
            timeZone: temporal.timeZone,
            allDay: false,
            checkConflicts: true,
        }, "calendar", 0.99, "calendar");
    }

    private parseCalendarConflict(
        text: string,
        temporal: TemporalResolution | null,
    ): PersonalIntentAction | null {
        const asksConflict = /\bconflito(?:s)?\b/.test(text)
            || /\b(?:horario|agenda)\b.*\b(?:livre|disponivel)\b/.test(text)
            || /\b(?:livre|disponivel)\b.*\b(?:horario|agenda)\b/.test(text);
        if (!asksConflict || !temporal?.instantIso) return null;

        const start = new Date(temporal.instantIso);
        const end = new Date(start.getTime() + this.eventDurationMs);
        return action("calendar.checkConflicts", {
            start: start.toISOString(),
            end: end.toISOString(),
            timeZone: temporal.timeZone,
        }, "calendar", 0.99, "calendar");
    }

    private parseActiveCalendarAction(text: string): PersonalIntentAction | null {
        if (!ACTIVE_EVENT_REFERENCE.test(text)) return null;
        if (/\b(?:cancela|cancele|cancelar|desmarca|desmarque|desmarcar)\b/.test(text)) {
            return action("calendar.cancel", {}, "calendar", 0.99, "calendar:active");
        }
        return null;
    }

    private parseCalendarReadAction(
        source: string,
        text: string,
        temporal: TemporalResolution | null,
    ): PersonalIntentAction | null {
        const searchMatch = /^(?:procura|procure|procurar|busca|busque|buscar|pesquisa|pesquise|encontra|encontre)\s+(?:o\s+|a\s+|um\s+|uma\s+)?(?:evento|reuni[aã]o|compromisso|consulta|entrevista)\s+(.+)$/iu.exec(source);
        if (searchMatch?.[1]) {
            if (!temporal) return null;
            const query = cleanQuery(stripTemporalExpression(searchMatch[1], temporal));
            if (!query) return null;
            return action("calendar.search", {
                query,
                timeMin: temporal.range.startIso,
                timeMax: temporal.range.endExclusiveIso,
                timeZone: temporal.timeZone,
            }, "calendar", 0.95);
        }

        const asksAgenda = /\b(?:agenda|calendario|compromissos|eventos|reunioes)\b/.test(text)
            || /\b(?:tenho|ha|tem)\b.*\b(?:algo|alguma coisa|compromisso|reuniao|evento)\b/.test(text)
            || /^(?:o que|que compromissos?|quais compromissos?)\s+(?:eu\s+)?tenho\b/.test(text);
        if (!asksAgenda || !temporal) return null;

        return action("calendar.list", {
            timeMin: temporal.range.startIso,
            timeMax: temporal.range.endExclusiveIso,
            timeZone: temporal.timeZone,
        }, "calendar", 0.97);
    }
}

/** Convenience entry point for the Fast Router. */
export function parsePersonalIntent(
    input: string,
    options: PersonalIntentParserOptions = {},
): PersonalIntentAction | null {
    return new PersonalIntentParser(options).parse(input);
}

function action(
    name: string,
    input: Record<string, unknown>,
    category: PersonalIntentCategory,
    confidence: number,
    serialKey?: string,
): PersonalIntentAction {
    return {
        name,
        input,
        category,
        confidence,
        ...(serialKey ? { serialKey } : {}),
    };
}

function mailSearchInput(
    source: string,
    text: string,
): { readonly input: Record<string, unknown>; readonly confidence: number } | null {
    if (!/\b(?:procura|procure|procurar|busca|busque|buscar|pesquisa|pesquise|encontra|encontre)\b/.test(text)
        || !/\b(?:email|emails|e-mail|e-mails)\b/.test(text)) {
        return null;
    }

    const subject = /\b(?:com\s+)?(?:o\s+)?assunto\s+["“”']?(.+?)["“”']?\s*$/iu.exec(source)?.[1];
    if (subject) {
        const value = cleanQuery(subject);
        return value ? { input: { subject: value }, confidence: 0.99 } : null;
    }

    const from = /\b(?:do\s+remetente|da\s+remetente|remetente|enviad[oa]s?\s+(?:por|pelo|pela))\s+["“”']?(.+?)["“”']?\s*$/iu.exec(source)?.[1];
    if (from) {
        const value = cleanQuery(from);
        return value ? { input: { from: value }, confidence: 0.99 } : null;
    }

    const topical = /\b(?:sobre|que\s+fala(?:m)?\s+(?:de|do|da)?|relacionad[oa]s?\s+(?:a|ao|a\s+))\s+["“”']?(.+?)["“”']?\s*$/iu.exec(source)?.[1];
    if (topical) {
        const value = cleanQuery(topical);
        return value ? { input: { query: value }, confidence: 0.97 } : null;
    }

    const loose = /\b(?:email|emails|e-mail|e-mails)\s+(?:do|da)\s+(.+?)\s*$/iu.exec(source)?.[1];
    if (loose) {
        const value = cleanQuery(loose);
        if (!value) return null;
        const looksTopical = /^(?:assunto|processo|projeto|vaga|entrevista|pedido|fatura|workflow)\b/i.test(value);
        return {
            input: looksTopical ? { query: value } : { from: value },
            confidence: looksTopical ? 0.88 : 0.91,
        };
    }

    return null;
}

function extractEmailWatchFilters(source: string): Record<string, unknown> {
    const request = source
        .replace(/[,;]?\s*(?:e\s+)?(?:me\s+)?(?:avisa|avise|avisar|notifica|notifique|notificar).*$/iu, "")
        .trim();
    const input: Record<string, unknown> = { unreadOnly: true };
    const from = /\b(?:e-?mail)\s+(?:novo\s+)?(?:do|da|de)\s+(.+?)(?=\s+(?:sobre|falando|dizendo|com\s+(?:o\s+)?assunto|que\s+fala)\b|[,;]|$)/iu.exec(request)?.[1];
    const subject = /\bcom\s+(?:o\s+)?assunto\s+["“”']?(.+?)["“”']?\s*$/iu.exec(request)?.[1];
    const query = /\b(?:sobre|falando\s+(?:que|de|sobre)?|dizendo\s+que|que\s+fala\s+(?:de|sobre))\s+(.+?)\s*$/iu.exec(request)?.[1];

    if (from) input.from = cleanQuery(from);
    if (subject) input.subject = cleanQuery(subject);
    else if (query) input.query = cleanQuery(query);
    return input;
}

function extractReminderLeadMinutes(text: string): number | null {
    const match = /\b(\d+|um|uma|dois|duas|cinco|dez|quinze|vinte|trinta|quarenta|sessenta)\s*(minutos?|horas?)\s+antes\b/.exec(text);
    if (!match) return null;
    const words: Record<string, number> = {
        um: 1,
        uma: 1,
        dois: 2,
        duas: 2,
        cinco: 5,
        dez: 10,
        quinze: 15,
        vinte: 20,
        trinta: 30,
        quarenta: 40,
        sessenta: 60,
    };
    const amount = /^\d+$/.test(match[1]) ? Number(match[1]) : words[match[1]];
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return match[2].startsWith("hora") ? amount * 60 : amount;
}

function extractRecurringClock(text: string): string | null {
    const match = /\b(?:as|a)\s*(\d{1,2})(?:\s*(?:h|:)\s*(\d{1,2}))?\b/.exec(text);
    if (match) {
        const hour = Number(match[1]);
        const minute = Number(match[2] ?? 0);
        if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
            return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        }
    }
    if (/\b(?:de|pela)\s+manha\b/.test(text)) return "08:00";
    if (/\b(?:de|a)\s+tarde\b/.test(text)) return "14:00";
    if (/\b(?:de|a)\s+noite\b/.test(text)) return "20:00";
    return null;
}

function extractTaskCompletionTitle(source: string): string | null {
    let value = source.replace(
        /^(?:conclui|conclua|concluir|finaliza|finalize|finalizar|completa|complete|completar)\s+(?:a\s+)?tarefa\s+/iu,
        "",
    );
    value = value.replace(
        /^(?:marca|marque|marcar)\s+(?:a\s+)?tarefa\s+/iu,
        "",
    );
    value = value.replace(/\s+como\s+(?:concluida|concluido|feita|feito)\s*$/iu, "");
    value = cleanQuery(value);
    return value && !/^(?:essa|esta|aquela|atual)$/iu.test(value) ? value : null;
}

function referenceMatches(reference: OperationalReference, requestedTitle: string): boolean {
    const expected = normalize(requestedTitle);
    const candidates = [
        reference.label,
        externalTextValue(reference.metadata?.externalTitle),
    ].filter((value): value is string => Boolean(value));

    return candidates.some(candidate => {
        const current = normalize(candidate);
        return current === expected
            || (expected.length >= 5 && (current.includes(expected) || expected.includes(current)));
    });
}

function externalTextValue(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return undefined;
    const external = value as { value?: unknown };
    return typeof external.value === "string" ? external.value : undefined;
}

function stripTemporalExpression(value: string, temporal: TemporalResolution | null): string {
    if (!temporal) return stripTrailingPunctuation(value);

    let result = [...temporal.matchedText]
        .sort((left, right) => right.length - left.length)
        .reduce(removeFoldedOccurrence, value);

    result = result
        .replace(/\bdepois\s+de\s+amanh[aã]\b/giu, " ")
        .replace(/\b(?:hoje|amanh[aã])\b/giu, " ")
        .replace(/\b(?:pr[oó]xim[oa]\s+)?(?:domingo|segunda(?:-feira)?|ter[cç]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[aá]bado)\b/giu, " ")
        .replace(/\b(?:na\s+)?(?:semana\s+que\s+vem|pr[oó]xima\s+semana)\b/giu, " ")
        .replace(/\bdaqui(?:\s+a)?\s+(?:\d+|[\p{L}\s]+?)\s+(?:horas?|dias?)\b/giu, " ")
        .replace(/\b(?:de|pela|a)\s+(?:manh[aã]|tarde|noite)\b/giu, " ")
        .replace(/\b(?:[aà]s)\s+(?:[01]?\d|2[0-3])(?:\s*(?:h|horas?)(?:\s*[0-5]?\d)?|\s*[:h]\s*[0-5]\d)?\b/giu, " ")
        .replace(/\b(?:[01]?\d|2[0-3])h(?:\s*[0-5]?\d)?\b/giu, " ");

    // Temporal phrases normally trail a title; remove the orphaned connector,
    // but preserve connectors inside titles such as "reunião com João".
    result = result.replace(/\s+(?:para|pra|em|na|no|[aà]s|at[eé])\s*$/iu, "");
    return stripTrailingPunctuation(result.replace(/\s+/g, " ").trim());
}

function removeFoldedOccurrence(value: string, phrase: string): string {
    const haystack = foldAccents(value);
    const needle = foldAccents(phrase).trim();
    if (!needle) return value;
    const index = haystack.indexOf(needle);
    if (index < 0) return value;

    // NFD accent folding keeps one base character for every precomposed
    // Portuguese letter, so indexes remain aligned with ordinary voice text.
    return `${value.slice(0, index)} ${value.slice(index + needle.length)}`;
}

function foldAccents(value: string): string {
    return value
        .toLocaleLowerCase("pt-BR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function cleanTitle(value: string): string {
    return stripTrailingPunctuation(value)
        .replace(/^(?:para|pra)(?:\s+eu)?\s+/iu, "")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanQuery(value: string): string {
    return stripTrailingPunctuation(value)
        .replace(/^(?:sobre|de|do|da|com\s+o\s+assunto)\s+/iu, "")
        .replace(/\s+/g, " ")
        .trim();
}

function hasMeaningfulTitle(value: string): boolean {
    const text = normalize(value);
    return text.length >= 2 && !/^(?:uma?|o|a|tarefa|evento|reuniao)\s*$/.test(text);
}

function sentenceCase(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    return trimmed.charAt(0).toLocaleUpperCase("pt-BR") + trimmed.slice(1);
}

function stripWakeWord(value: string): string {
    return value.replace(/^\s*ultron\s*[,;:!-]?\s*/iu, "");
}

function stripTrailingPunctuation(value: string): string {
    return value.replace(/[\s.!?,;:]+$/gu, "").trim();
}

function normalize(value: string): string {
    return value
        .toLocaleLowerCase("pt-BR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[.!?,;:]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
