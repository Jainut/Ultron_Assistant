import assert from "node:assert/strict";
import test from "node:test";

import type { ToolResult } from "../shared/types.ts";
import {
    formatToolExecutionResponses,
    type ToolResponseFormatter,
} from "../src/tools/tool-response-formatting.ts";

const formatter: ToolResponseFormatter = {
    formatResponse(_name: string, result: ToolResult): string {
        return result.speech ?? result.message;
    },
};

test("resumo composto só usa Feito quando todas as ações estão confirmadas", () => {
    assert.equal(formatToolExecutionResponses(formatter, [
        { name: "one", result: { success: true, status: "confirmed", message: "Primeira." } },
        { name: "two", result: { success: true, status: "confirmed", message: "Segunda." } },
    ]), "Feito.");
});

test("resumo composto preserva estados accepted e optimistic honestamente", () => {
    assert.equal(formatToolExecutionResponses(formatter, [
        {
            name: "app.open",
            result: {
                success: true,
                status: "accepted",
                message: "Aplicativo aceito.",
                speech: "Abrindo o aplicativo.",
            },
        },
        {
            name: "device.control",
            result: {
                success: true,
                status: "optimistic",
                message: "Estado presumido.",
                speech: "Enviei o comando; ainda não confirmei o estado.",
            },
        },
    ]), "Abrindo o aplicativo. Enviei o comando; ainda não confirmei o estado.");
});

test("resumo composto não esconde uma falha parcial", () => {
    assert.equal(formatToolExecutionResponses(formatter, [
        { name: "one", result: { success: true, status: "accepted", message: "Primeira aceita." } },
        { name: "two", result: { success: false, status: "failed", message: "Segunda falhou." } },
    ]), "Primeira aceita. Segunda falhou.");
});
