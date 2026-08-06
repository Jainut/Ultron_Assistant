from pathlib import Path
import librosa
import numpy as np

import soundfile as sf
from kokoro import KPipeline

ROOT_DIR = Path(__file__).resolve().parent.parent

OUTPUT_DIR = ROOT_DIR / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_FILE = OUTPUT_DIR / "ultron_test.wav"

def main() -> None:
    print("Carregando modelo do Kokoro...")
    pipeline = KPipeline(lang_code="p")

    text = (
            "Ok, todos os sistemas funcionando normalmente"
            ".."
            "Como posso ajudá-lo?"
            )

    print("Gerando áudio...")
    generator = pipeline(text, voice="pm_alex", speed=0.75)

    for index, (_, phonemes, audio) in enumerate(generator):
        print(f"Trecho gerado: {index}...")
        print(f"Fonetica: {phonemes}")

        audio_array = (
            audio.cpu().numpy()
            if hasattr(audio, "cpu")
            else audio.asarray(audio)
        )

        audio_array = np.squeeze(audio_array.astype(np.float32))

        pitch_steps = -5.5
        audio_array = librosa.effects.pitch_shift(y = audio_array, sr=24000, n_steps=pitch_steps)

        volume = 1.5
        audio_array = np.clip(audio_array * volume, -1.0, 1.0)

        sf.write(OUTPUT_FILE, audio_array, samplerate=24000)

        break
    
    print(f"Áudio gerado com sucesso em: {OUTPUT_FILE}")

if __name__ == "__main__":
    main()