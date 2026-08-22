import assert from "node:assert/strict";
import test from "node:test";

import {
    PtBrTemporalContext,
    resolvePtBrTemporal,
    temporalDueDate,
} from "../src/time/index.ts";

// Thursday, 2026-08-20 10:30:00 in America/Sao_Paulo (UTC-03).
const BASE = new Date("2026-08-20T13:30:00.000Z");

function resolver(base = BASE, timeZone = "America/Sao_Paulo"): PtBrTemporalContext {
    return new PtBrTemporalContext({ timeZone, now: () => new Date(base.getTime()) });
}

test("resolve hoje, amanhã e depois de amanhã como intervalos locais absolutos", () => {
    const context = resolver();

    const today = context.resolve("o que tenho hoje?");
    const tomorrow = context.resolve("tarefas para amanhã");
    const afterTomorrow = context.resolve("agenda de depois de amanhã");

    assert.equal(today?.range.startIso, "2026-08-20T03:00:00.000Z");
    assert.equal(today?.range.endExclusiveIso, "2026-08-21T03:00:00.000Z");
    assert.equal(today?.allDay, true);
    assert.equal(tomorrow?.localDate, "2026-08-21");
    assert.equal(afterTomorrow?.localDate, "2026-08-22");
});

test("combina dia e horário em um instante provider-ready", () => {
    const result = resolver().resolve("marque amanhã às 15h30");

    assert.equal(result?.kind, "instant");
    assert.equal(result?.instantIso, "2026-08-21T18:30:00.000Z");
    assert.equal(result?.localDate, "2026-08-21");
    assert.equal(result?.localTime, "15:30");
    assert.equal(result?.range.endExclusiveIso, "2026-08-21T18:31:00.000Z");
});

test("horário sem data prefere o futuro e avança para amanhã quando já passou", () => {
    assert.equal(resolver().resolve("me lembre às 09h")?.instantIso, "2026-08-21T12:00:00.000Z");
    assert.equal(resolver().resolve("me lembre às 11h")?.instantIso, "2026-08-20T14:00:00.000Z");
});

test("resolve próxima ocorrência de dias da semana coerentemente", () => {
    const context = resolver();

    assert.equal(context.resolve("sexta às 14h")?.localDate, "2026-08-21");
    assert.equal(context.resolve("quinta às 09h")?.localDate, "2026-08-27");
    assert.equal(context.resolve("próxima quinta")?.localDate, "2026-08-27");
    assert.equal(context.resolve("domingo")?.localDate, "2026-08-23");
});

test("semana que vem começa segunda e termina na segunda seguinte", () => {
    const result = resolver().resolve("quais compromissos tenho na semana que vem?");

    assert.equal(result?.granularity, "week");
    assert.equal(result?.range.startIso, "2026-08-24T03:00:00.000Z");
    assert.equal(result?.range.endExclusiveIso, "2026-08-31T03:00:00.000Z");
});

test("dia da semana qualificado pela semana que vem fica dentro da próxima semana", () => {
    const result = resolver().resolve("reunião terça da semana que vem às 16h");

    assert.equal(result?.localDate, "2026-08-25");
    assert.equal(result?.localTime, "16:00");
    assert.equal(result?.instantIso, "2026-08-25T19:00:00.000Z");
});

test("resolve offsets de horas como duração absoluta e dias como calendário local", () => {
    const context = resolver();

    assert.equal(context.resolve("me lembre daqui a 2 horas")?.instantIso, "2026-08-20T15:30:00.000Z");
    assert.equal(context.resolve("prazo daqui vinte e um dias")?.localDate, "2026-09-10");
    assert.equal(context.resolve("daqui 2 dias às 15h")?.instantIso, "2026-08-22T18:00:00.000Z");
});

test("manhã, tarde e noite geram intervalos com fim exclusivo", () => {
    const context = resolver();
    const morning = context.resolve("amanhã de manhã");
    const afternoon = context.resolve("amanhã à tarde");
    const night = context.resolve("amanhã à noite");

    assert.equal(morning?.range.startIso, "2026-08-21T09:00:00.000Z");
    assert.equal(morning?.range.endExclusiveIso, "2026-08-21T15:00:00.000Z");
    assert.equal(afternoon?.range.startIso, "2026-08-21T15:00:00.000Z");
    assert.equal(afternoon?.range.endExclusiveIso, "2026-08-21T21:00:00.000Z");
    assert.equal(night?.range.startIso, "2026-08-21T21:00:00.000Z");
    assert.equal(night?.range.endExclusiveIso, "2026-08-22T03:00:00.000Z");
});

test("período sem data já encerrado avança para o próximo dia", () => {
    const late = resolver(new Date("2026-08-20T19:30:00.000Z")); // 16:30 local
    const morning = late.resolve("de manhã");
    const afternoon = late.resolve("à tarde");

    assert.equal(morning?.localDate, "2026-08-21");
    assert.equal(afternoon?.localDate, "2026-08-20");
});

test("timezone é configurável e o relógio continua sendo um instante absoluto", () => {
    const result = resolver(BASE, "UTC").resolve("amanhã às 15h");

    assert.equal(result?.timeZone, "UTC");
    assert.equal(result?.instantIso, "2026-08-21T15:00:00.000Z");
});

test("helper funcional e conversão de due date não dependem do relógio global", () => {
    const result = resolvePtBrTemporal("amanhã", {
        timeZone: "America/Sao_Paulo",
        now: () => new Date(BASE),
    });

    assert.ok(result);
    assert.equal(temporalDueDate(result).toISOString(), "2026-08-21T03:00:00.000Z");
    assert.equal(temporalDueDate(result, "end").toISOString(), "2026-08-22T02:59:59.999Z");
});

test("retorna null sem expressão temporal e rejeita timezone inválido", () => {
    assert.equal(resolver().resolve("abra o Spotify"), null);
    assert.throws(() => resolver(BASE, "Marte/Olympus"), /Timezone IANA inválido/);
});
