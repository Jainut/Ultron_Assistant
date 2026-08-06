import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { routeCommand } from "./assistant/command-router.ts";
import { playAudio } from "./speech/audio_player.ts";
import { TextToSpeechService } from "./speech/text-to-speech.ts";

const terminal = createInterface({
    input: stdin,
    output: stdout,
});

const tts = new TextToSpeechService();

async function main(): Promise<void> {
    try {
        console.log("Carregando sistema de voz...");

        await tts.start();

        console.log("Ultron iniciado");
        console.log("Digite um comando ou 'sair' para encerrar o programa");

        while (true) {
            const command = await terminal.question("\nMe> ");

            if (command.trim().toLowerCase() === "sair") {
                console.log("Encerrando o programa...");
                break;
            }

            const result = await routeCommand(command);

            console.log(`Ultron> ${result.message}`);

            if (result.shouldSpeak === false) {
                continue;
            }

            try {
                const speechText =
                    result.speech ?? result.message;

                const audioPath = await tts.synthesize(
                    speechText,
                );

                await playAudio(audioPath);
            } catch (error: unknown) {
                console.error(
                    "Erro no sistema de voz:",
                    error,
                );
            }
        }
    } finally {
        tts.stop();
        terminal.close();
    }
}

main().catch((error: unknown) => {
    console.error("FATAL ERROR:", error);
    process.exitCode = 1;
});