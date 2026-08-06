import { playAudio } from "./audio_player.ts";
import { synthesizeSpeech } from "./text-to-speech.ts";

export async function speak(text: string): Promise<void> {
    const synthesis = await synthesizeSpeech(text);

    if (!synthesis.success || !synthesis.audioPath) {
        throw new Error(
            synthesis.error ?? "Não foi possível gerar a fala.",
        );
    }

    await playAudio(synthesis.audioPath);
}