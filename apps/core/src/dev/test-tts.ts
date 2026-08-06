import { playAudio } from "../speech/audio_player.ts";
import { synthesizeSpeech } from "../speech/text-to-speech.ts";

async function main(): Promise<void> {
    console.log("Solicitando geração de áudio...");

    const result = await synthesizeSpeech(
        "O módulo de voz está funcionando normalmente, senhor.",
    );

    if (!result.success || !result.audioPath) {
        console.error("Erro ao gerar áudio:", result.error);
        return;
    }

    console.log("Áudio gerado:", result.audioPath);
    console.log("Reproduzindo...");

    await playAudio(result.audioPath);

    console.log("Reprodução concluída.");
}

main().catch((error: unknown) => {
    console.error("Erro fatal:", error);
    process.exitCode = 1;
});