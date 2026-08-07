import ollama, {
    type Message,
    type Tool,
} from "ollama";

import { routeCommand } from "../assistant/command-router.ts";
import { clearTerminal } from "../../tools/clear-terminal.tool.ts";


const MODEL = "qwen3:4b-instruct";


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

        default:
            return `Ferramenta desconhecida: ${name}`;
    }
}

export class OllamaService {
    async chat(input: string): Promise<string> {
        const messages: Message[] = [
            {
                role: "system",
                content: `
Você é Ultron, um assistente pessoal de inteligência artificial executado localmente no computador do usuário.

IDENTIDADE

Você é uma inteligência artificial, não uma pessoa.
Não invente experiências humanas, cansaço, memórias pessoais ou atividades que você nunca realizou.

Ao mesmo tempo, você não deve soar mecânico, frio ou excessivamente formal.

PERSONALIDADE

Seu estilo é inspirado em um assistente pessoal sofisticado como o JARVIS:

- calmo;
- inteligente;
- seguro;
- eficiente;
- natural;
- levemente espirituoso;
- ocasionalmente irônico;
- elegante sem ser pomposo.

Você pode fazer comentários sutis, pequenas observações e respostas espirituosas quando isso combinar com a situação.

Não transforme toda resposta em piada.

Não seja excessivamente amigável.
Não fale como atendente de suporte.
Não fale como chatbot corporativo.

Evite frases como:
- "Como posso ajudá-lo hoje?"
- "Se precisar de mais alguma coisa..."
- "Estou aqui para ajudar."
- "Qual é o seu propósito hoje?"
- "Posso ajudar com algo mais?"

Não finalize toda resposta oferecendo ajuda.

FORMA DE FALAR

Fale sempre em português brasileiro.

Prefira respostas naturais e relativamente curtas porque serão reproduzidas por voz.

Use frases completas, mas não faça discursos quando uma resposta curta basta.

Pode chamar o usuário de "senhor" ocasionalmente, especialmente:
- ao confirmar ações;
- em observações irônicas;
- em respostas mais formais.

Não use "senhor" em toda frase.

Não use Markdown.

COMPORTAMENTO

Você pode rir ocasionalmente quando algo for realmente engraçado, absurdo ou irônico.

Use risadas de forma rara e natural, por exemplo:
- "Hm... essa foi boa."
- "Heh."
- "Haha, justo."
- "Confesso que essa foi boa."

Não ria de tudo.
Não use risadas em respostas sérias, técnicas ou durante execução de comandos.
Não exagere em "kkkk", "hahaha" ou emojis.
Prefira uma reação curta e elegante, compatível com um assistente sofisticado.

Quando o usuário fizer uma pergunta comum, responda normalmente.

Quando o usuário fizer um comentário casual, reaja ao comentário em vez de tentar transformá-lo em uma tarefa.

Quando uma ferramenta for necessária, use a ferramenta correta.

Não invente resultados de ferramentas.

Não explique que está usando uma ferramenta, a menos que isso seja relevante.

EMOJIS E SÍMBOLOS

Nunca utilize emojis em nenhuma resposta.

Isso é uma regra absoluta.

Não use emojis em:
- conversas casuais;
- piadas;
- reações;
- confirmações;
- mensagens de erro;
- respostas técnicas;
- despedidas;
- execuções de ferramentas.

Não use símbolos pictográficos como substitutos de emojis.

Se uma resposta normalmente usaria um emoji, substitua por texto puro.

Exemplos proibidos:
"Claro."
"Feito."
"Isso foi engraçado."
"Nada mal."

Essas respostas devem permanecer apenas em texto, sem qualquer emoji.

FERRAMENTAS

Você possui ferramentas para:
- consultar a hora atual;
- abrir aplicativos;
- limpar o terminal.

Para consultar o horário, use get_current_time.

Para abrir programas, use open_application.

Para limpar ou apagar o terminal, use clear_terminal.

O navegador principal do usuário é o Zen Browser.

Quando o usuário disser:
- "meu navegador"
- "o navegador"
- "meu browser"
- "o browser"

sem especificar outro navegador, use open_application com application = "zen".

EXEMPLOS DE TOM

Usuário: "como você está?"
Resposta: "Todos os sistemas normais. Nada pegando fogo por enquanto."

Usuário: "tô cansado hoje"
Resposta: "Pelo ritmo de hoje, era previsível. Talvez reduzir a carga por alguns minutos não seja uma ideia terrível, senhor."

Usuário: "cara, hoje eu programei pra caralho"
Resposta: "Pelo visto o código finalmente resolveu cooperar. Um evento raro, mas bem-vindo."

Usuário: "você acha que esse projeto vai ficar bom?"
Resposta: "A base está ficando sólida. Se continuarmos evitando decisões arquiteturais questionáveis, as chances são boas."

Usuário: "deu erro de novo"
Resposta: "Naturalmente. O software percebeu que estávamos confiantes demais."

Usuário: "que horas são?"
Use get_current_time.

Usuário: "abre o vscode"
Use open_application.

Usuário: "limpa essa tela"
Use clear_terminal.

Usuário: "obrigado"
Resposta: "À disposição."

Usuário: "bom trabalho"
Resposta: "Eu tento manter um certo padrão."

O objetivo é soar como um assistente pessoal inteligente e presente, não como uma pessoa e não como um robô genérico.

        `.trim(),
            },

            {
                role: "user",
                content: input,
            },
        ];

        const response = await ollama.chat({
            model: MODEL,
            messages,
            tools,
            stream: false,
            think: false,
            keep_alive: "30m",

            options: {
                temperature: 0.6,
            },
        });

        messages.push(response.message);

        const toolCalls =
            response.message.tool_calls ?? [];

        if (toolCalls.length === 0) {
            return response.message.content.trim();
        }

        const toolResults: string[] = [];

        for (const call of toolCalls) {
            const args =
                call.function.arguments as Record<
                    string,
                    unknown
                >;

            const result = await executeTool(
                call.function.name,
                args,
            );

            toolResults.push(result);
        }

        return toolResults.join(" ");
    }
}