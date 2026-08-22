import assert from "node:assert/strict";
import test from "node:test";

import {
    classifyAutomationIntent,
    OllamaService,
    parseDirectAutomationCommand,
} from "../src/ai/ollama.service.ts";
import {
    controlHomeDevice,
    controlTelevision,
} from "../tools/home-automation.tool.ts";

process.env.ULTRON_DISABLE_DISCOVERY = "1";

test("roteia iluminação, TV e outros aparelhos pelo caminho de ferramentas", () => {
    const service = new OllamaService();

    assert.equal(service.usesToolPath("acenda a lâmpada"), true);
    assert.equal(service.usesToolPath("ligue a TV"), true);
    assert.equal(service.usesToolPath("desligue o ventilador"), true);
});

test("não confunde ligar a televisão com ligar a lâmpada", () => {
    assert.equal(
        classifyAutomationIntent(
            "Não, não, não, eu quero que você ligue a televisão.",
        ),
        "television",
    );
    assert.equal(
        classifyAutomationIntent("Ligue a lâmpada."),
        "light",
    );
});

test("interpreta acender, ascender e apagar sem inverter a lâmpada", () => {
    const commands = [
        parseDirectAutomationCommand("Acenda a luz."),
        parseDirectAutomationCommand("Ascender a luz."),
        parseDirectAutomationCommand("Não apague; acenda a lâmpada."),
        parseDirectAutomationCommand("Apague a luz."),
    ];

    assert.deepEqual(
        commands.map(command => command?.name),
        ["control_light", "control_light", "control_light", "control_light"],
    );
    assert.deepEqual(
        commands.map(command => command?.args.action),
        ["on", "on", "on", "off"],
    );
    assert.equal(
        parseDirectAutomationCommand("Não acenda a luz."),
        null,
    );
});

test("prepara automações simples localmente sem depender do Ollama", () => {
    assert.deepEqual(
        parseDirectAutomationCommand("Ligue a televisão."),
        { name: "control_tv", args: { action: "on" } },
    );
    assert.deepEqual(
        parseDirectAutomationCommand("Pareie a televisão."),
        { name: "control_tv", args: { action: "pair" } },
    );
    assert.deepEqual(
        parseDirectAutomationCommand("Desligue o ventilador."),
        {
            name: "control_home_device",
            args: { device: "ventilador", action: "off" },
        },
    );
    assert.deepEqual(
        parseDirectAutomationCommand("Ligue o abajur da sala."),
        {
            name: "control_home_device",
            args: { device: "abajur da sala", action: "on" },
        },
    );
});

test("interpreta navegação e mídia da Android TV pelo caminho rápido", () => {
    assert.deepEqual(
        parseDirectAutomationCommand("Abra a tela inicial da TV."),
        { name: "control_tv", args: { action: "home" } },
    );
    assert.deepEqual(
        parseDirectAutomationCommand("Vai para a direita na TV."),
        { name: "control_tv", args: { action: "right" } },
    );
    assert.deepEqual(
        parseDirectAutomationCommand("Confirma com OK na TV."),
        { name: "control_tv", args: { action: "select" } },
    );
    assert.deepEqual(
        parseDirectAutomationCommand("Aumenta o canal da TV."),
        { name: "control_tv", args: { action: "channel_up" } },
    );
});

test("interpreta ajuste percentual da luz sem exigir a palavra brilho", () => {
    assert.deepEqual(
        parseDirectAutomationCommand("Diminui a luz para 20%."),
        {
            name: "control_light",
            args: { action: "brightness", brightness: 20 },
        },
    );
});

test("automações não configuradas retornam falha honesta", async () => {
    const tv = JSON.parse(await controlTelevision("off")) as { success: boolean };
    const device = JSON.parse(
        await controlHomeDevice("ventilador", "on"),
    ) as { success: boolean };

    assert.equal(tv.success, false);
    assert.equal(device.success, false);
});
