import assert from "node:assert/strict";
import test from "node:test";

import {
    classifyAutomationIntent,
    parseDirectAutomationCommand,
} from "../src/ai/ollama.service.ts";
import { extractTelevisionPairingCode } from "../src/intent/fast-intent-router.ts";

test("roteamento determinístico preserva ações de luz, TV e aparelho genérico", () => {
    const cases = [
        [
            "Assender a iluminação.",
            { name: "control_light", args: { action: "on" } },
        ],
        [
            "Deixe a luz azul.",
            {
                name: "control_light",
                args: { action: "color", red: 0, green: 0, blue: 255 },
            },
        ],
        [
            "Coloque o brilho da lâmpada em 0%.",
            {
                name: "control_light",
                args: { action: "brightness", brightness: 0 },
            },
        ],
        [
            "Volte para a tela inicial da televisão.",
            { name: "control_tv", args: { action: "home" } },
        ],
        [
            "Desmute a TV.",
            { name: "control_tv", args: { action: "unmute" } },
        ],
        [
            "Tire a TV do mudo.",
            { name: "control_tv", args: { action: "unmute" } },
        ],
        [
            "Abra o portão.",
            {
                name: "control_home_device",
                args: { device: "portao", action: "open" },
            },
        ],
        [
            "Ligue o abajur do escritório.",
            {
                name: "control_home_device",
                args: { device: "abajur do escritorio", action: "on" },
            },
        ],
    ] as const;

    for (const [input, expected] of cases) {
        assert.deepEqual(parseDirectAutomationCommand(input), expected, input);
    }
});

test("roteamento determinístico não executa uma ação de energia negada", () => {
    assert.equal(parseDirectAutomationCommand("Não ligue a televisão."), null);
    assert.equal(parseDirectAutomationCommand("Não desligue o ventilador."), null);
    assert.deepEqual(
        parseDirectAutomationCommand("Não apague a luz; acenda a luz."),
        { name: "control_light", args: { action: "on" } },
    );
});

test("classificação local diferencia domínios sem consultar serviços externos", () => {
    assert.equal(classifyAutomationIntent("Aumente o volume da TV."), "television");
    assert.equal(classifyAutomationIntent("Feche a cortina."), "home_device");
    assert.equal(classifyAutomationIntent("Acenda a luz azul."), "light");
    assert.equal(classifyAutomationIntent("Explique o que é TypeScript."), null);
});

test("parser de pareamento aceita PIN alfanumérico e fala dígito a dígito", () => {
    assert.equal(extractTelevisionPairingCode("Código 21891f"), "21891F");
    assert.equal(extractTelevisionPairingCode("PIN da TV 2-1-8-9-1-F"), "21891F");
    assert.equal(
        extractTelevisionPairingCode("pin nove oito sete seis cinco quatro"),
        "987654",
    );
});

test("parser de pareamento rejeita códigos incompletos ou texto arbitrário", () => {
    assert.equal(extractTelevisionPairingCode("código 12345"), null);
    assert.equal(extractTelevisionPairingCode("pin 1234567"), null);
    assert.equal(extractTelevisionPairingCode("ligue a televisão"), null);
});
