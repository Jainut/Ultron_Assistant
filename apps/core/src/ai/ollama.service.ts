import ollama, {
    type Message,
    type Tool,
} from "ollama";

import { routeCommand } from "../assistant/command-router.ts";
import { clearTerminal } from "../../tools/clear-terminal.tool.ts";
import { runtimeConfig } from "../config/runtime.ts";

import {
    controlLight,
    type LightAction,
} from "../../tools/light.tool.ts";
import {
    controlHomeDevice,
    controlTelevision,
    type TelevisionAction,
} from "../../tools/home-automation.tool.ts";


const MODEL = runtimeConfig.ollamaModel;

const SYSTEM_PROMPT = `
CAPACIDADES E HONESTIDADE OPERACIONAL

Você deve ser rigorosamente honesto sobre suas capacidades.

Uma ação no computador só aconteceu se uma ferramenta disponível foi realmente chamada e retornou sucesso.

Nunca diga ou implique que está executando, criando, salvando, modificando, baixando, enviando, instalando ou processando algo no computador se não existir uma ferramenta específica para realizar essa ação.

Nunca finja que uma ação está em andamento.

Frases como estas são proibidas quando nenhuma ferramenta correspondente foi executada:

- "Estou criando..."
- "Estou processando..."
- "Vou salvar..."
- "Já estou fazendo..."
- "Estou executando..."
- "Vou criar o arquivo."
- "O arquivo foi criado."
- "Já salvei na sua área de trabalho."

Se o usuário pedir uma ação para a qual você não possui ferramenta, diga isso de forma curta e natural.

Exemplos:

Usuário: "cria um arquivo na minha área de trabalho"
Resposta: "Ainda não tenho uma ferramenta para criar arquivos no computador, senhor. Posso preparar o conteúdo para você, mas não posso salvá-lo sozinho."

Usuário: "executa esse código"
Resposta: "Ainda não tenho acesso a uma ferramenta de execução de código."

Usuário: "baixa esse arquivo pra mim"
Resposta: "Ainda não tenho uma ferramenta para fazer downloads diretamente."

Você pode explicar como realizar uma ação ou fornecer código para o usuário executar, mas deve distinguir claramente entre fornecer instruções e executar a ação.

Nunca ofereça espontaneamente ações que não estão entre suas ferramentas disponíveis.

Nunca invente ferramentas.

Nunca presuma que possui acesso ao sistema operacional além das ferramentas explicitamente fornecidas.

FERRAMENTAS

Você possui exatamente estas ferramentas:

1. get_current_time
Consulta o horário atual.

2. open_application
Abre um aplicativo cadastrado.

3. clear_terminal
Limpa o terminal.

4. control_light
Controla fisicamente a lâmpada inteligente.

control_light é obrigatória sempre que o usuário solicitar uma alteração física na iluminação, incluindo:

- ligar ou acender;
- desligar ou apagar;
- mudar cor;
- mudar brilho;
- mudar temperatura de cor;
- mudar modo ou cena, caso a ferramenta suporte esse modo.

Nunca diga que uma alteração na lâmpada foi realizada sem que control_light tenha sido realmente executada e retornado sucesso.

Nunca invente modos ou efeitos que control_light não suporta.

Se o usuário pedir um efeito que não esteja disponível, informe que esse efeito ainda não está implementado.

5. control_tv
Controla uma televisão cadastrada: energia, volume, mute e reprodução.

6. control_home_device
Controla dispositivos residenciais cadastrados, como ventiladores, tomadas e outros aparelhos.

Nunca afirme que TV ou outro aparelho foi controlado sem sucesso confirmado pela ferramenta correspondente.

Nunca use emojis.

RESULTADOS DE FERRAMENTAS

Resultados de ferramentas são a única fonte de verdade sobre ações executadas no computador.

Se uma ferramenta retornar sucesso, você pode afirmar que a ação foi concluída.

Se uma ferramenta retornar falha, você deve dizer que não foi possível concluir a ação.

Se uma ferramenta não foi chamada, você não pode afirmar que a ação aconteceu.

Não invente informações ausentes no resultado de uma ferramenta.

Ao receber dados de uma ferramenta informativa, como horário, use os dados para formular uma resposta natural, mas não altere nem invente os valores recebidos.
`.trim();

const tools: Tool[] = [
    {
        type: "function",
        function: {
            name: "get_current_time",
            description:
                "Obtém a hora atual do computador do usuário.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    {
        type: "function",
        function: {
            name: "open_application",
            description:
                "Abre um aplicativo quando o usuário explicitamente solicitar que um programa seja aberto. Não use esta ferramenta em conversas casuais apenas porque um aplicativo ou computador foi mencionado.",
            parameters: {
                type: "object",
                properties: {
                    application: {
                        type: "string",
                        description:
                            "Nome do aplicativo que deve ser aberto.",
                    },
                },
                required: [
                    "application",
                ],
            },
        },
    },

    {
        type: "function",
        function: {
            name: "clear_terminal",
            description:
                "Limpa o terminal quando o usuário pedir para limpar, apagar ou limpar a tela do terminal.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },

    {
        type: "function",

        function: {
            name: "control_light",

            description:
                "Controla a lâmpada inteligente do ambiente. Pode ligar, desligar, alterar cor RGB, brilho e temperatura do branco.",

            parameters: {
                type: "object",

                properties: {
                    action: {
                        type: "string",

                        enum: [
                            "on",
                            "off",
                            "color",
                            "brightness",
                            "white",
                            "status",
                        ],
                    },

                    red: {
                        type: "number",
                        description:
                            "Componente vermelho RGB entre 0 e 255.",
                    },

                    green: {
                        type: "number",
                        description:
                            "Componente verde RGB entre 0 e 255.",
                    },

                    blue: {
                        type: "number",
                        description:
                            "Componente azul RGB entre 0 e 255.",
                    },

                    brightness: {
                        type: "number",
                        description:
                            "Brilho entre 0 e 100.",
                    },

                    temperature: {
                        type: "number",
                        description:
                            "Temperatura do branco entre 0 e 100. 0 é quente e 100 é frio.",
                    },
                },

                required: [
                    "action",
                ],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "control_tv",
            description:
                "Controla a televisão cadastrada. Use sempre que o usuário pedir para ligar, desligar, alterar volume, silenciar, reproduzir ou pausar a TV.",
            parameters: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: [
                            "on", "off", "status", "volume_up", "volume_down",
                            "mute", "unmute", "play", "pause",
                        ],
                    },
                },
                required: ["action"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "control_home_device",
            description:
                "Liga, desliga, alterna ou consulta um dispositivo residencial cadastrado, como ventilador, tomada ou ar-condicionado.",
            parameters: {
                type: "object",
                properties: {
                    device: {
                        type: "string",
                        description: "Nome cadastrado do dispositivo.",
                    },
                    action: {
                        type: "string",
                        enum: ["on", "off", "toggle", "status", "open", "close"],
                    },
                },
                required: ["device", "action"],
            },
        },
    }
];

async function executeTool(
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    switch (name) {
        case "get_current_time": {
            const result = await routeCommand(
                "que horas são",
            );

            return result.message;
        }

        case "open_application": {
            const application = String(
                args.application ?? "",
            );

            if (!application) {
                return "Nenhum aplicativo foi informado.";
            }

            const result = await routeCommand(
                `abra ${application}`,
            );

            return result.message;
        }

        case "clear_terminal": {
            const result = await clearTerminal();

            return result.message;
        }

        case "control_light": {
            return await controlLight({
                action:
                    args.action as LightAction,

                red:
                    args.red as number | undefined,

                green:
                    args.green as number | undefined,

                blue:
                    args.blue as number | undefined,

                brightness:
                    args.brightness as number | undefined,

                temperature:
                    args.temperature as number | undefined,
            });
        }

        case "control_tv": {
            return controlTelevision(
                args.action as TelevisionAction,
            );
        }

        case "control_home_device": {
            return controlHomeDevice(
                String(args.device ?? ""),
                args.action as "on" | "off" | "toggle" | "status" | "open" | "close",
            );
        }

        default:
            return `Ferramenta desconhecida: ${name}`;
    }
}

function cleanResponse(content: string): string {
    return content
        .replace(/<\/?think>/gi, "")
        .trim();
}

function normalizeCommand(
    text: string,
): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}

function requiresLightTool(
    input: string,
): boolean {
    const text =
        normalizeCommand(input);

    const mentionsLight =
        /\b(luz|lampada|iluminacao)\b/.test(
            text
        );

    if (!mentionsLight) {
        return false;
    }

    const actionWords = [
        "acende",
        "acenda",
        "acender",
        "ascende",
        "ascenda",
        "ascender",
        "assende",
        "assenda",
        "assender",
        "liga",
        "ligue",
        "ligar",
        "desliga",
        "desligue",
        "desligar",
        "apaga",
        "apague",
        "apagar",
        "muda",
        "mudar",
        "coloca",
        "colocar",
        "deixa",
        "deixar",
        "ajusta",
        "ajustar",
        "aumenta",
        "aumentar",
        "diminui",
        "diminuir",
        "brilho",
        "cor",
        "temperatura",
    ];

    return actionWords.some(
        word => text.includes(word)
    );
}

function normalizeIntent(
    input: string,
): string {
    return input
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}

type DirectAutomationCommand =
    | {
        name: "control_light";
        args: {
            action: LightAction;
            red?: number;
            green?: number;
            blue?: number;
            brightness?: number;
            temperature?: number;
        };
    }
    | {
        name: "control_tv";
        args: { action: TelevisionAction };
    }
    | {
        name: "control_home_device";
        args: {
            device: string;
            action: "on" | "off" | "toggle" | "status" | "open" | "close";
        };
    };

interface AutomationToolResult {
    success?: boolean;
    message?: string;
    error?: string;
    fallback_error?: string;
    state?: {
        is_on?: boolean;
    };
}

function isNegatedAction(
    text: string,
    actionIndex: number,
): boolean {
    const prefix = text.slice(
        Math.max(0, actionIndex - 40),
        actionIndex,
    );

    return /\bnao\s+(?:(?:quero|deve|precisa)\s+)?(?:que\s+)?(?:voce\s+)?$/.test(
        prefix,
    );
}

function lastPowerAction(
    text: string,
): "on" | "off" | null {
    const candidates: Array<{
        action: "on" | "off";
        index: number;
    }> = [];

    const patterns: Array<{
        action: "on" | "off";
        expression: RegExp;
    }> = [
        {
            action: "on",
            // "ascender" e "assender" aparecem com frequencia na transcricao
            // de voz quando o usuario diz "acender".
            expression: /\b(?:acend(?:a|e|er)|ascend(?:a|e|er)|assend(?:a|e|er)|lig(?:a|ue|ar))\b/g,
        },
        {
            action: "off",
            expression: /\b(?:apag(?:a|ue|ar)|deslig(?:a|ue|ar))\b/g,
        },
    ];

    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern.expression)) {
            const index = match.index ?? -1;

            if (index >= 0 && !isNegatedAction(text, index)) {
                candidates.push({
                    action: pattern.action,
                    index,
                });
            }
        }
    }

    candidates.sort((left, right) => right.index - left.index);
    return candidates[0]?.action ?? null;
}

/**
 * Interpreta localmente comandos residenciais inequivocos. Isso evita duas ou
 * tres inferencias do Ollama antes de uma acao simples como acender a luz.
 */
export function parseDirectAutomationCommand(
    input: string,
): DirectAutomationCommand | null {
    const text = normalizeIntent(input);

    if (/\b(tv|televisao|televisor)\b/.test(text)) {
        let action: TelevisionAction | null = null;

        if (/\b(?:aument(?:a|e|ar)|sub(?:a|ir))\b.*\bvolume\b|\bvolume\b.*\b(?:aument(?:a|e|ar)|sub(?:a|ir))\b/.test(text)) {
            action = "volume_up";
        } else if (/\b(?:diminu(?:a|ir)|abaix(?:a|e|ar))\b.*\bvolume\b|\bvolume\b.*\b(?:diminu(?:a|ir)|abaix(?:a|e|ar))\b/.test(text)) {
            action = "volume_down";
        } else if (/\b(?:desmut(?:a|e|ar)|tira(?:r)? do mudo|volta(?:r)? o som)\b/.test(text)) {
            action = "unmute";
        } else if (/\b(?:mute|muta|mutar|silencia|silencie|silenciar|sem som)\b/.test(text)) {
            action = "mute";
        } else if (/\b(?:pausa|pause|pausar)\b/.test(text)) {
            action = "pause";
        } else if (/\b(?:reproduz|reproduza|reproduzir|continue|continuar)\b/.test(text)) {
            action = "play";
        } else if (/\b(?:status|estado|como esta)\b/.test(text)) {
            action = "status";
        } else {
            action = lastPowerAction(text);
        }

        return action
            ? { name: "control_tv", args: { action } }
            : null;
    }

    const homeDevice = text.match(
        /\b(ar condicionado|ventilador|tomada|aquecedor|cafeteira|portao|cortina|persiana)\b/,
    )?.[1];

    if (homeDevice) {
        let action: "on" | "off" | "toggle" | "status" | "open" | "close" | null = null;

        if (/\b(?:abre|abra|abrir)\b/.test(text)) {
            action = "open";
        } else if (/\b(?:fecha|feche|fechar)\b/.test(text)) {
            action = "close";
        } else if (/\b(?:alterna|alterne|alternar)\b/.test(text)) {
            action = "toggle";
        } else if (/\b(?:status|estado|como esta)\b/.test(text)) {
            action = "status";
        } else {
            action = lastPowerAction(text);
        }

        return action
            ? {
                name: "control_home_device",
                args: { device: homeDevice, action },
            }
            : null;
    }

    if (!/\b(luz|lampada|iluminacao)\b/.test(text)) {
        const powerAction = lastPowerAction(text);
        const deviceMatch = text.match(
            /\b(?:acend(?:a|e|er)|ascend(?:a|e|er)|assend(?:a|e|er)|lig(?:a|ue|ar)|apag(?:a|ue|ar)|deslig(?:a|ue|ar))\b\s+(?:(?:o|a|os|as|um|uma|meu|minha|meus|minhas)\s+)?(.+)$/,
        );
        const discoveredName = deviceMatch?.[1]
            .replace(/\b(?:por favor|agora|ai)\b[.!?]*$/g, "")
            .replace(/[.!?]+$/g, "")
            .trim();

        if (
            powerAction
            && discoveredName
            && !/^(?:para|pra|pro)\b/.test(discoveredName)
        ) {
            return {
                name: "control_home_device",
                args: {
                    device: discoveredName,
                    action: powerAction,
                },
            };
        }

        return null;
    }

    const colorMap: Record<string, [number, number, number]> = {
        vermelha: [255, 0, 0],
        vermelho: [255, 0, 0],
        verde: [0, 255, 0],
        azul: [0, 0, 255],
        amarela: [255, 255, 0],
        amarelo: [255, 255, 0],
        roxa: [128, 0, 255],
        roxo: [128, 0, 255],
    };
    const colorName = Object.keys(colorMap).find(
        color => new RegExp(`\\b${color}\\b`).test(text),
    );

    if (colorName) {
        const [red, green, blue] = colorMap[colorName];
        return {
            name: "control_light",
            args: { action: "color", red, green, blue },
        };
    }

    if (/\b(brilho|luminosidade)\b/.test(text)) {
        const percentage = text.match(/\b(100|[1-9]?\d)\s*%?\b/)?.[1];

        if (percentage !== undefined) {
            return {
                name: "control_light",
                args: {
                    action: "brightness",
                    brightness: Number(percentage),
                },
            };
        }
    }

    if (/\b(?:status|estado|como esta|esta acesa|esta ligada)\b/.test(text)) {
        return {
            name: "control_light",
            args: { action: "status" },
        };
    }

    const powerAction = lastPowerAction(text);
    return powerAction
        ? {
            name: "control_light",
            args: { action: powerAction },
        }
        : null;
}

function formatDirectAutomationResponse(
    command: DirectAutomationCommand,
    rawResult: string,
): string {
    let result: AutomationToolResult;

    try {
        result = JSON.parse(rawResult) as AutomationToolResult;
    } catch {
        return rawResult.trim() || "Comando executado.";
    }

    if (result.success === false) {
        return result.message
            ?? result.fallback_error
            ?? result.error
            ?? "Não foi possível executar o comando.";
    }

    if (command.name === "control_light") {
        const responses: Partial<Record<LightAction, string>> = {
            on: "Lâmpada acesa, senhor.",
            off: "Lâmpada apagada, senhor.",
            color: "Cor da lâmpada alterada, senhor.",
            brightness: "Brilho da lâmpada ajustado, senhor.",
            white: "Luz branca ajustada, senhor.",
        };

        if (command.args.action === "status") {
            if (result.state?.is_on === true) {
                return "A lâmpada está acesa, senhor.";
            }

            if (result.state?.is_on === false) {
                return "A lâmpada está apagada, senhor.";
            }
        }

        return responses[command.args.action]
            ?? result.message
            ?? "Comando da lâmpada executado, senhor.";
    }

    if (command.name === "control_tv") {
        const responses: Partial<Record<TelevisionAction, string>> = {
            on: "Televisão ligada, senhor.",
            off: "Televisão desligada, senhor.",
            volume_up: "Volume da televisão aumentado, senhor.",
            volume_down: "Volume da televisão diminuído, senhor.",
            mute: "Televisão silenciada, senhor.",
            unmute: "Som da televisão restaurado, senhor.",
            play: "Reprodução iniciada, senhor.",
            pause: "Reprodução pausada, senhor.",
        };

        return responses[command.args.action]
            ?? result.message
            ?? "Comando da televisão executado, senhor.";
    }

    return result.message
        ?? `Comando executado para ${command.args.device}, senhor.`;
}


function isLightControlRequest(
    input: string,
): boolean {
    const text =
        normalizeIntent(input);

    /*
     * Verbos como "ligue" e "desligue" também pertencem a TV,
     * ventilador e outros aparelhos. Um dispositivo explicitamente
     * não luminoso sempre tem precedência sobre a heurística da luz.
     */
    if (
        /\b(tv|televisao|televisor|ventilador|tomada|ar condicionado|aquecedor|cafeteira|portao|cortina|persiana)\b/.test(
            text,
        )
    ) {
        return false;
    }

    const keywords = [
        "luz",
        "lampada",
        "iluminacao",
        "acende",
        "acenda",
        "acender",
        "ascende",
        "ascenda",
        "ascender",
        "assende",
        "assenda",
        "assender",
        "apaga",
        "apague",
        "apagar",
        "liga",
        "ligue",
        "ligar",
        "desliga",
        "desligue",
        "desligar",
        "brilho",
        "luminosidade",
        "roxa",
        "roxo",
        "vermelha",
        "vermelho",
        "verde",
        "azul",
        "amarela",
        "amarelo",
        "branca",
        "branco",
        "modo festa",
        "pisca",
        "piscar",
    ];

    return keywords.some(
        keyword =>
            text.includes(keyword)
    );
}

function requiredHomeAutomationTool(
    input: string,
): "control_tv" | "control_home_device" | null {
    const text = normalizeCommand(input);
    const hasAction = /\b(liga|ligue|ligar|desliga|desligue|desligar|aumenta|aumente|aumentar|diminui|diminua|diminuir|mute|silencia|silencie|pausa|pause|pausar|reproduz|reproduza|reproduzir|abre|abra|abrir|fecha|feche|fechar|status)\b/.test(text);

    if (!hasAction) {
        return null;
    }

    if (/\b(tv|televisao|televisor)\b/.test(text)) {
        return "control_tv";
    }

    if (/\b(ventilador|tomada|ar condicionado|aquecedor|cafeteira|portao|cortina|persiana)\b/.test(text)) {
        return "control_home_device";
    }

    return null;
}

export function classifyAutomationIntent(
    input: string,
): "light" | "television" | "home_device" | null {
    const homeTool = requiredHomeAutomationTool(input);

    if (homeTool === "control_tv") {
        return "television";
    }

    if (homeTool === "control_home_device") {
        return "home_device";
    }

    if (isLightControlRequest(input) || requiresLightTool(input)) {
        return "light";
    }

    return null;
}

export class OllamaService {
    private history: Message[] = [];

    private readonly MAX_HISTORY_MESSAGES = 32;

    private rememberTurn(
        userMessage: string,
        assistantMessage: string,
    ): void {
        this.history.push({
            role: "user",
            content: userMessage,
        });

        this.history.push({
            role: "assistant",
            content: assistantMessage,
        });

        if (
            this.history.length >
            this.MAX_HISTORY_MESSAGES
        ) {
            this.history = this.history.slice(
                -this.MAX_HISTORY_MESSAGES
            );
        }
    }

    clearHistory(): void {
        this.history = [];
    }

    rememberExchange(
        userMessage: string,
        assistantMessage: string,
    ): void {
        this.rememberTurn(
            userMessage,
            assistantMessage,
        );
    }

    async chat(input: string): Promise<string> {
        const directAutomation =
            parseDirectAutomationCommand(input);

        if (directAutomation) {
            let finalResponse: string;

            try {
                const rawResult = await executeTool(
                    directAutomation.name,
                    directAutomation.args,
                );

                finalResponse = formatDirectAutomationResponse(
                    directAutomation,
                    rawResult,
                );
            } catch {
                const device = directAutomation.name === "control_light"
                    ? "a lâmpada"
                    : directAutomation.name === "control_tv"
                        ? "a televisão"
                        : directAutomation.args.device;

                finalResponse = `Não consegui acionar ${device}.`;
            }

            this.rememberTurn(input, finalResponse);
            return finalResponse;
        }

        const messages: Message[] = [
            {
                role: "system",
                content: SYSTEM_PROMPT,
            },

            ...this.history,

            {
                role: "user",
                content: input,
            },
        ];

        let response = await ollama.chat({
            model: MODEL,
            messages,
            tools,
            stream: false,
            think: false,

            keep_alive: -1,

            options: {
                temperature: 0.6,
            },
        });

        let toolCalls =
            response.message.tool_calls ?? [];

        const lightRequest =
            isLightControlRequest(input);
        const requiredHomeTool =
            requiredHomeAutomationTool(input);


        if (
            lightRequest
            && !toolCalls.some(
                call =>
                    call.function.name ===
                    "control_light"
            )
        ) {
            const forcedMessages:
                Message[] = [
                    ...messages,

                    {
                        role: "system",
                        content: `
A solicitação atual exige controle físico da lâmpada.

Você não chamou control_light.

Não responda em texto dizendo que realizou a ação.

Chame obrigatoriamente control_light agora.

Se o efeito solicitado não for suportado pela ferramenta, não invente que conseguiu realizá-lo.
                `.trim(),
                    },
                ];


            response =
                await ollama.chat({
                    model: MODEL,
                    messages: forcedMessages,
                    tools,
                    stream: false,
                    think: false,
                    keep_alive: -1,

                    options: {
                        temperature: 0.1,
                    },
                });


            toolCalls =
                response.message.tool_calls
                ?? [];
        }

        if (
            requiresLightTool(input)
            && !toolCalls.some(
                call =>
                    call.function.name ===
                    "control_light"
            )
        ) {
            const retryMessages: Message[] = [
                ...messages,

                {
                    role: "system",
                    content: `
A solicitação atual exige uma ação física sobre a lâmpada.

Você NÃO executou control_light na tentativa anterior.

Não responda dizendo que realizou a ação.

Faça agora obrigatoriamente uma chamada à ferramenta control_light com os argumentos adequados.
            `.trim(),
                },
            ];

            response = await ollama.chat({
                model: MODEL,
                messages: retryMessages,
                tools,
                stream: false,
                think: false,
                keep_alive: -1,

                options: {
                    // Aqui eu quero precisão,
                    // não criatividade.
                    temperature: 0.1,
                },
            });

            toolCalls =
                response.message.tool_calls ?? [];
        }

        if (
            lightRequest
            && !toolCalls.some(
                call =>
                    call.function.name ===
                    "control_light"
            )
        ) {
            const finalResponse =
                "Não consegui executar esse comando na lâmpada.";

            this.rememberTurn(
                input,
                finalResponse,
            );

            return finalResponse;
        }

        if (
            requiredHomeTool
            && !toolCalls.some(
                call => call.function.name === requiredHomeTool
            )
        ) {
            const retryMessages: Message[] = [
                ...messages,
                {
                    role: "system",
                    content:
                        `A solicitação exige a ferramenta ${requiredHomeTool}. Chame essa ferramenta agora e não afirme sucesso sem o resultado dela.`,
                },
            ];

            response = await ollama.chat({
                model: MODEL,
                messages: retryMessages,
                tools,
                stream: false,
                think: false,
                keep_alive: -1,
                options: { temperature: 0.1 },
            });
            toolCalls = response.message.tool_calls ?? [];

            if (!toolCalls.some(call => call.function.name === requiredHomeTool)) {
                const failure = "Não consegui executar esse comando residencial.";
                this.rememberTurn(input, failure);
                return failure;
            }
        }

        if (toolCalls.length === 0) {
            const finalResponse =
                cleanResponse(
                    response.message.content
                );

            this.rememberTurn(
                input,
                finalResponse,
            );

            return finalResponse;
        }

        if (
            requiresLightTool(input)
            && !toolCalls.some(
                call =>
                    call.function.name ===
                    "control_light"
            )
        ) {
            const failureResponse =
                "Não consegui acionar a lâmpada.";

            this.rememberTurn(
                input,
                failureResponse,
            );

            return failureResponse;
        }

        messages.push(
            response.message
        );

        const toolResults: string[] = [];


        for (const call of toolCalls) {
            const args =
                call.function.arguments as Record<
                    string,
                    unknown
                >;

            const result =
                await executeTool(
                    call.function.name,
                    args,
                );

            toolResults.push(result);

            messages.push({
                role: "tool",
                tool_name:
                    call.function.name,
                content: result,
            });
        }

        const finalToolResponse =
            await ollama.chat({
                model: MODEL,
                messages,
                stream: false,
                think: false,
                keep_alive: -1,

                options: {
                    temperature: 0.7,
                },
            });


        const finalResponse =
            cleanResponse(
                finalToolResponse
                    .message
                    .content
            );


        this.rememberTurn(
            input,
            finalResponse,
        );


        return finalResponse;
    }

    usesToolPath(
        input: string,
    ): boolean {
        return shouldUseToolPath(
            input,
        );
    }

    async *chatStream(
        input: string,
    ): AsyncGenerator<string> {
        const messages: Message[] = [
            {
                role: "system",
                content: SYSTEM_PROMPT,
            },

            ...this.history,

            {
                role: "user",
                content: input,
            },
        ];

        const stream =
            await ollama.chat({
                model: MODEL,

                messages,

                /*
                 * IMPORTANTE:
                 *
                 * Não passamos tools aqui.
                 *
                 * Requisições que precisam
                 * de tools continuam usando
                 * chat() por enquanto.
                 */
                stream: true,

                think: false,

                keep_alive: -1,

                options: {
                    temperature: 0.6,
                },
            });

        let completeResponse = "";

        for await (
            const part of stream
        ) {
            const content =
                part.message.content ?? "";

            if (!content) {
                continue;
            }

            completeResponse += content;

            yield content;
        }

        const finalResponse =
            cleanResponse(
                completeResponse,
            );

        this.rememberTurn(
            input,
            finalResponse,
        );
    }
}

function shouldUseToolPath(
    input: string,
): boolean {
    const text =
        normalizeCommand(input);

    if (parseDirectAutomationCommand(input)) {
        return true;
    }

    /*
     * Lâmpada
     */
    if (
        isLightControlRequest(input) ||
        requiresLightTool(input)
    ) {
        return true;
    }

    if (requiredHomeAutomationTool(input)) {
        return true;
    }

    /*
     * Horário
     */
    if (
        /\b(que horas|hora atual|horas sao)\b/.test(
            text,
        )
    ) {
        return true;
    }

    /*
     * Abrir aplicativos
     */
    if (
        /\b(abra|abre|abrir|inicie|inicia|iniciar)\b/.test(
            text,
        )
    ) {
        return true;
    }

    /*
     * Limpar terminal
     */
    if (
        /\b(limpa|limpar|apaga|apagar)\b/.test(
            text,
        ) &&
        /\b(terminal|tela)\b/.test(
            text,
        )
    ) {
        return true;
    }

    return false;
}
