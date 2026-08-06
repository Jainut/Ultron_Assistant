import {createInterface} from "node:readline/promises";
import {stdin, stdout} from "node:process";
import {routeCommand} from "./assistant/command-router.ts";
import { speak } from "./speech/speak.ts";

const terminal = createInterface({
    input: stdin,
    output: stdout,
});

async function main(): Promise<void> {
    console.log("Ultron iniciado")
    console.log("Digite um comando ou 'sair' para encerrar o programa");

    try {
    while (true) {
        const command = await terminal.question("\nMe> ");

        if (command.trim().toLowerCase() === "sair") {
            console.log("Encerrando o programa...");
            break;
        }

        const result = await routeCommand(command);
        console.log(`Ultron> ${result.message}`);

        try {
            await speak(result.speech ?? result.message);
        } catch (error) {
            console.error("Erro no sistema de voz:", error);
        }
    }
}finally {
    terminal.close();
    }
}

main().catch((error: unknown) => {
    console.error("FATAL ERROR:", error);
    process.exitCode = 1;
});