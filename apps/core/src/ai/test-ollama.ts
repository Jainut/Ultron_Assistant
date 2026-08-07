import { OllamaService } from "./ollama.service.ts";


const ai = new OllamaService();


async function main(): Promise<void> {
const tests = [
    "oi ultron, como você está?",
    "que horas são?",
    "me fala a hora aí",
    "abre o zen pra mim",
    "abre meu navegador",
    "abre o vscode",
    "limpa o terminal",
    "apaga a tela do terminal",
    "cara, hoje eu programei pra caralho",
    "tô cansado hoje",
    "você acha que esse projeto vai ficar bom?",
    "me explica o que é uma API",
];

    for (const input of tests) {
        console.log(`\nMe> ${input}`);

        const response = await ai.chat(
            input,
        );

        console.log(
            `Ultron> ${response}`,
        );
    }
}


main().catch(console.error);