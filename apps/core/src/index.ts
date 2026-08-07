import { unlink } from "node:fs/promises";
import { OllamaService } from "./ai/ollama.service.ts";
import { routeCommand } from "./assistant/command-router.ts";
import { TextToSpeechService } from "./speech/text-to-speech.ts";
import { SpeechToTextService } from "./speech/speech-to-text.ts";
import { playAudio } from "./speech/audio_player.ts";


const tts = new TextToSpeechService();
const stt = new SpeechToTextService();
const ai = new OllamaService();


async function main(): Promise<void> {
    console.log("Inicializando Ultron...\n");

    try {
        console.log("Carregando sistema de voz...");
        await tts.start();

        console.log("Carregando reconhecimento de voz...");
        await stt.start();

        console.log("\nUltron iniciado.");
        console.log('Diga "Ultron" para chamar o assistente.');

        while (true) {
            let command: string;

            try {
                command = await stt.listen();
            } catch (error) {
                console.error(
                    "Erro ao escutar:",
                    error,
                );

                continue;
            }

            console.log(`\nVocê> ${command}`);

            const normalizedCommand = command
                .trim()
                .toLowerCase();

            if (normalizedCommand === "sair") {
                console.log(
                    "Encerrando o programa...",
                );

                break;
            }

            try {
                const response = await ai.chat(command);
                console.log(`Ultron> ${response}`);
                const speechText = response;

                let audioPath: string | null = null;

                try {
                    audioPath = await tts.synthesize(
                        speechText,
                    );

                    await playAudio(audioPath);
                } finally {
                    if (audioPath) {
                        await unlink(
                            audioPath,
                        ).catch(() => { });
                    }
                }
            } catch (error) {
                console.error(
                    "Erro ao processar comando:",
                    error,
                );
            }
        }
    } finally {
        stt.stop();
        tts.stop();
    }
}


main().catch((error: unknown) => {
    console.error(
        "FATAL ERROR:",
        error,
    );

    process.exitCode = 1;
});