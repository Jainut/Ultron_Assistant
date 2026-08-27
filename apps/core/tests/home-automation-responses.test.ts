import assert from "node:assert/strict";
import test from "node:test";

import {
    formatAndroidTvResult,
    formatTelevisionPairingResult,
    homeAssistantResultMetadata,
} from "../tools/home-automation.tool.ts";
import { automationResult } from "../src/tools/core-tool-registry.ts";

test("consulta Android TV sem observação não é promovida a confirmação pelo registry", () => {
    const raw = formatAndroidTvResult("TV de teste", "status", {
        online: true,
        confirmed: false,
        status: "unknown",
        observedPowered: false,
        desiredPower: true,
        pending: true,
    });
    const result = automationResult(raw, "status");
    assert.equal(result.success, true);
    assert.equal(result.status, "unknown");
    assert.match(result.message, /não confirmou/);
    assert.equal(result.data?.state?.powered, undefined);
});

test("envio Android TV permanece aceito até confirmação do aparelho", () => {
    for (const action of ["on", "off", "toggle"] as const) {
        const result = automationResult(formatAndroidTvResult("TV de teste", action, {
            commandSent: true,
            confirmed: false,
            status: "accepted",
            desiredPower: action === "on",
            pending: true,
        }), action);
        assert.equal(result.status, "accepted");
        assert.match(result.message, /Enviei/);
        assert.match(result.message, /não (?:foi )?confirm/);
        assert.doesNotMatch(result.message, /confirmou que está/);
    }
});

test("observação Android TV confirmada preserva resposta conclusiva", () => {
    const result = automationResult(formatAndroidTvResult("TV de teste", "on", {
        powered: true,
        observedPowered: true,
        confirmed: true,
        status: "confirmed",
        changed: false,
    }), "on");
    assert.equal(result.status, "confirmed");
    assert.match(result.message, /confirmou que está ligada/);
});

test("PIN solicitado ainda não significa TV pareada", () => {
    for (const explicitStatus of [undefined, "accepted"]) {
        const result = automationResult(JSON.stringify({
            success: true,
            message: "Diga o código da TV.",
            state: { paired: false, pairingRequired: true, confirmed: false, status: explicitStatus },
        }), "pair");
        assert.equal(result.status, "accepted");
    }
});

test("pareamento concluído não promove ação pendente a estado físico confirmado", () => {
    const raw = formatTelevisionPairingResult({
        device: "TV de teste",
        paired: true,
        pairingPersisted: true,
        requestedAction: "on",
        executedAction: "on",
        actionResult: { confirmed: false, status: "accepted", commandSent: true, desiredPower: true },
    });
    const result = automationResult(raw, "pair");
    assert.equal(result.status, "confirmed");
    assert.equal(result.data?.action, "pair");
    assert.equal((result.data?.state?.actionResult as { status?: string }).status, "accepted");
    assert.match(result.message, /TV pareada/);
    assert.match(result.message, /resultado ainda não foi confirmado/);
    assert.doesNotMatch(result.message, /pareada e ligada|confirmou que está ligada/);
});

test("falha da ação pendente preserva sucesso do pareamento e informa a falha", () => {
    const result = automationResult(formatTelevisionPairingResult({
        device: "TV de teste",
        paired: true,
        pairingPersisted: true,
        requestedAction: "off",
        actionError: "Estado desconhecido. Não enviei Power.",
    }), "pair");
    assert.equal(result.success, true);
    assert.equal(result.status, "confirmed");
    assert.match(result.message, /TV pareada/);
    assert.match(result.message, /comando pendente não foi concluído/);
    assert.match(result.message, /Não enviei Power/);
});

test("falha ao salvar pareamento é comunicada sem prometer persistência", () => {
    const result = automationResult(formatTelevisionPairingResult({
        device: "TV de teste",
        paired: true,
        pairingPersisted: false,
    }), "pair");
    assert.match(result.message, /Não consegui salvar o pareamento/);
    assert.match(result.message, /necessário novamente/);
});

test("normalização continua compatível com resultados antigos da lâmpada", () => {
    assert.equal(automationResult(JSON.stringify({ success: true, confirmed: true }), "on").status, "confirmed");
    assert.equal(automationResult(JSON.stringify({ success: true, optimistic: true }), "on").status, "optimistic");
    assert.equal(automationResult(JSON.stringify({ success: true }), "on").status, "accepted");
    assert.equal(automationResult(JSON.stringify({ success: false, status: "confirmed" }), "on").status, "failed");
});

test("Home Assistant não promove POST aceito nem estado unavailable a confirmação", () => {
    assert.equal(homeAssistantResultMetadata([{ state: "on" }], "on").status, "accepted");
    assert.equal(homeAssistantResultMetadata({ state: "unavailable" }, "status").status, "unknown");
    assert.equal(homeAssistantResultMetadata(null, "status").status, "unknown");
    assert.equal(homeAssistantResultMetadata({ state: "off" }, "status").status, "confirmed");
    assert.equal(automationResult(JSON.stringify({ success: true }), "status").status, "unknown");
});
