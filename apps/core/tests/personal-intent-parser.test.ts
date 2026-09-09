import assert from "node:assert/strict";
import test from "node:test";

import type { OperationalContextSnapshot } from "../src/context/operational-context.ts";
import {
    PersonalIntentParser,
    parsePersonalIntent,
} from "../src/intent/personal-intent-parser.ts";
import { PtBrTemporalContext } from "../src/time/pt-br-temporal-context.ts";

// Thursday, 2026-08-20 10:30 in America/Sao_Paulo.
const BASE = new Date("2026-08-20T13:30:00.000Z");

function parser(context: Readonly<OperationalContextSnapshot> = {}): PersonalIntentParser {
    return new PersonalIntentParser({
        temporalContext: new PtBrTemporalContext({
            timeZone: "America/Sao_Paulo",
            now: () => new Date(BASE),
        }),
        operationalContext: context,
    });
}

test("conecta a conta Google somente com pedido explícito", () => {
    assert.deepEqual(parser().parse("Ultron, conecte minha conta Google"), {
        name: "google.connect",
        input: {},
        category: "automation",
        confidence: 0.99,
        serialKey: "provider:google",
    });
    assert.equal(parser().parse("minha conta Google"), null);
});

test("lista ou lê emails novos pelo caminho determinístico mail.list", () => {
    const value = parser().parse("Leia meus emails novos.");
    assert.equal(value?.name, "mail.list");
    assert.deepEqual(value?.input, { unreadOnly: true });

    assert.deepEqual(parser().parse("Liste meus emails"), {
        name: "mail.list",
        input: {},
        category: "mail",
        confidence: 0.94,
    });
});

test("lê, resume e marca o email ativo sem fabricar ID", () => {
    assert.deepEqual(parser().parse("Leia esse email"), {
        name: "mail.read",
        input: {},
        category: "mail",
        confidence: 0.99,
        serialKey: "personal-context",
    });
    assert.equal(parser().parse("Resuma esse email")?.name, "mail.summarize");
    assert.deepEqual(parser().parse("Resuma essa conversa")?.input, { wholeThread: true });
    assert.equal(parser().parse("Marque esse email como lido")?.name, "mail.markRead");
    assert.equal(parser().parse("Resuma um email")?.name, undefined);
});

test("pesquisa emails por remetente, assunto e texto livre", () => {
    assert.deepEqual(parser().parse("Procure emails do remetente João")?.input, { from: "João" });
    assert.deepEqual(parser().parse("Busque email com assunto Processo Seletivo")?.input, {
        subject: "Processo Seletivo",
    });
    assert.deepEqual(parser().parse("Procure o email que fala do processo seletivo")?.input, {
        query: "processo seletivo",
    });
    assert.deepEqual(parser().parse("Procure emails do João")?.input, { from: "João" });
    assert.deepEqual(parser().parse("Veja o email do processo seletivo")?.input, {
        query: "processo seletivo",
    });
    assert.deepEqual(parser().parse("Leia o email do contrato")?.input, { query: "contrato" });
});

test("cria tarefa com título e converte amanhã para ISO absoluto", () => {
    const value = parser().parse("Crie uma tarefa para responder o Lucas amanhã.");
    assert.equal(value?.name, "task.create");
    assert.deepEqual(value?.input, {
        title: "Responder o Lucas",
        due: "2026-08-21T03:00:00.000Z",
        timeZone: "America/Sao_Paulo",
        allDay: true,
    });
});

test("tarefa com horário preserva instante e não é all-day", () => {
    assert.deepEqual(parser().parse("Crie tarefa revisar o contrato amanhã às 15h")?.input, {
        title: "Revisar o contrato",
        due: "2026-08-21T18:00:00.000Z",
        timeZone: "America/Sao_Paulo",
        allDay: false,
    });
});

test("relaciona tarefa explícita ao email ativo sem ler conteúdo externo", () => {
    const value = parser().parse("Me lembre de responder esse email amanhã");
    assert.deepEqual(value?.input, {
        title: "Responder esse email",
        due: "2026-08-21T03:00:00.000Z",
        timeZone: "America/Sao_Paulo",
        allDay: true,
        useActiveEmail: true,
    });
    assert.equal(
        parser().parse("Crie uma tarefa com o que preciso fazer nesse email amanhã"),
        null,
    );
});

test("cria tarefa sem prazo quando título é suficiente, mas rejeita título ausente", () => {
    assert.deepEqual(parser().parse("Crie uma tarefa para comprar café")?.input, {
        title: "Comprar café",
    });
    assert.equal(parser().parse("Crie uma tarefa amanhã"), null);
});

test("lista e pesquisa tarefas com filtros absolutos quando informados", () => {
    assert.deepEqual(parser().parse("Liste minhas tarefas de amanhã")?.input, {
        dueMin: "2026-08-21T03:00:00.000Z",
        dueMax: "2026-08-22T03:00:00.000Z",
        timeZone: "America/Sao_Paulo",
    });
    assert.deepEqual(parser().parse("Procure a tarefa comprar leite")?.input, {
        query: "comprar leite",
    });
});

test("conclui referência ativa e ID explícito", () => {
    assert.deepEqual(parser().parse("Conclua essa tarefa"), {
        name: "task.complete",
        input: {},
        category: "tasks",
        confidence: 0.99,
        serialKey: "personal-context",
    });
    assert.deepEqual(parser().parse("Conclua a tarefa ID abc-123")?.input, {
        taskId: "abc-123",
    });
});

test("conclui por texto somente quando corresponde à tarefa ativa", () => {
    const withActive = parser({
        activeTask: {
            type: "task",
            id: "task-42",
            label: "Comprar leite",
            updatedAt: BASE.toISOString(),
        },
    });
    assert.deepEqual(withActive.parse("Conclua a tarefa comprar leite")?.input, {
        taskId: "task-42",
    });
    assert.equal(withActive.parse("Conclua a tarefa pagar aluguel"), null);
    assert.equal(parser().parse("Conclua a tarefa comprar leite"), null);
});

test("lista agenda hoje, amanhã e sexta em intervalos absolutos", () => {
    assert.deepEqual(parser().parse("O que tenho hoje?")?.input, {
        timeMin: "2026-08-20T03:00:00.000Z",
        timeMax: "2026-08-21T03:00:00.000Z",
        timeZone: "America/Sao_Paulo",
    });
    assert.equal(parser().parse("Tenho alguma coisa amanhã?")?.name, "calendar.list");
    assert.deepEqual(parser().parse("Mostre minha agenda de sexta")?.input, {
        timeMin: "2026-08-21T03:00:00.000Z",
        timeMax: "2026-08-22T03:00:00.000Z",
        timeZone: "America/Sao_Paulo",
    });
    assert.equal(parser().parse("Mostre minha agenda"), null);
});

test("pesquisa evento somente quando há consulta e intervalo suficientes", () => {
    const value = parser().parse("Procure a reunião do Fakeboxd amanhã");
    assert.equal(value?.name, "calendar.search");
    assert.deepEqual(value?.input, {
        query: "Fakeboxd",
        timeMin: "2026-08-21T03:00:00.000Z",
        timeMax: "2026-08-22T03:00:00.000Z",
        timeZone: "America/Sao_Paulo",
    });
    assert.equal(parser().parse("Procure a reunião do Fakeboxd"), null);
});

test("checa conflito por uma janela padrão coerente de uma hora", () => {
    assert.deepEqual(parser().parse("Tenho conflito sexta às 15h?")?.input, {
        start: "2026-08-21T18:00:00.000Z",
        end: "2026-08-21T19:00:00.000Z",
        timeZone: "America/Sao_Paulo",
    });
    assert.equal(parser().parse("Tenho conflito sexta?"), null);
});

test("cria evento com início absoluto, fim padrão e verificação de conflito", () => {
    const value = parser().parse("Marque uma reunião com João sexta às 15h");
    assert.equal(value?.name, "calendar.create");
    assert.deepEqual(value?.input, {
        summary: "Reunião com João",
        start: "2026-08-21T18:00:00.000Z",
        end: "2026-08-21T19:00:00.000Z",
        timeZone: "America/Sao_Paulo",
        allDay: false,
        checkConflicts: true,
    });
});

test("não inventa horário ou título ausentes ao criar evento", () => {
    assert.equal(parser().parse("Marque uma reunião amanhã"), null);
    assert.equal(parser().parse("Marque sexta às 15h"), null);
});

test("referência de reunião ativa pode ser cancelada pela tool protegida", () => {
    assert.deepEqual(parser().parse("Cancele essa reunião"), {
        name: "calendar.cancel",
        input: {},
        category: "calendar",
        confidence: 0.99,
        serialKey: "calendar:active",
    });
});

test("helper público aceita relógio injetado e duração configurável", () => {
    const value = parsePersonalIntent("Crie um evento Revisão amanhã às 14h", {
        temporalContext: new PtBrTemporalContext({
            timeZone: "America/Sao_Paulo",
            now: () => new Date(BASE),
        }),
        defaultEventDurationMinutes: 30,
    });
    assert.equal(value?.name, "calendar.create");
    assert.equal(value?.input.start, "2026-08-21T17:00:00.000Z");
    assert.equal(value?.input.end, "2026-08-21T17:30:00.000Z");
});

test("monta briefing diário pelo caminho local", () => {
    assert.deepEqual(parser().parse("Ultron, o que eu tenho pra hoje?"), {
        name: "personal.dailyBriefing",
        input: {
            at: "2026-08-20T03:00:00.000Z",
            timeZone: "America/Sao_Paulo",
        },
        category: "information",
        confidence: 0.98,
        serialKey: "personal-context",
    });
});

test("cria monitor de email com remetente e tema sem chamar provider", () => {
    assert.deepEqual(
        parser().parse("Quando chegar um email do GitHub sobre workflow falhando, me avisa."),
        {
            name: "automation.createEmailWatch",
            input: {
                unreadOnly: true,
                from: "GitHub",
                query: "workflow falhando",
            },
            category: "automation",
            confidence: 0.97,
            serialKey: "automation:email-watch",
        },
    );
});

test("referência contextual cria monitor da thread ativa", () => {
    const context: OperationalContextSnapshot = {
        activeEmail: {
            type: "email",
            id: "mail-1",
            updatedAt: BASE.toISOString(),
            metadata: { threadId: "thread-42" },
        },
    };
    assert.deepEqual(parser(context).parse("E me avisa se eles responderem."), {
        name: "automation.createEmailWatch",
        input: { threadId: "thread-42" },
        category: "automation",
        confidence: 0.98,
        serialKey: "mail-watch:thread-42",
    });
});

test("cria lembrete recorrente antes das reuniões", () => {
    assert.deepEqual(parser().parse("Me avisa quinze minutos antes das reuniões."), {
        name: "automation.createCalendarReminder",
        input: { leadMinutes: 15 },
        category: "automation",
        confidence: 0.99,
        serialKey: "automation:calendar-reminder",
    });
});

test("agenda briefing diário com horário de parede", () => {
    assert.deepEqual(
        parser().parse("Todo dia às 8 me diga meus compromissos e tarefas."),
        {
            name: "automation.createDailyBriefing",
            input: { time: "08:00", timeZone: "America/Sao_Paulo" },
            category: "automation",
            confidence: 0.98,
            serialKey: "automation:daily-briefing",
        },
    );
});

test("lista avisos persistentes sem interpretar seu conteúdo", () => {
    assert.deepEqual(parser().parse("Quais avisos pendentes eu tenho?"), {
        name: "notification.list",
        input: { status: "pending" },
        category: "information",
        confidence: 0.98,
        serialKey: "notifications",
    });
    assert.equal(parser().parse("Me avisa assim que puder"), null);
});

test("frases ambíguas e comandos de outros domínios retornam null", () => {
    assert.equal(parser().parse("Resuma o que aconteceu"), null);
    assert.equal(parser().parse("Conclua isso"), null);
    assert.equal(parser().parse("Abra o Spotify"), null);
    assert.equal(parser().parse("Ligue a luz"), null);
});
