from pathlib import Path
import librosa
import numpy as np
import soundfile as sf
from kokoro import KPipeline
from time import perf_counter

SAMPLE_RATE = 24000
pipeline = KPipeline(lang_code="p")

def apply_effects(audio: np.ndarray) -> np.ndarray:
    audio_array = (
        audio.cpu().numpy()
        if hasattr(audio, "cpu")
        else np.asarray(audio)
    )

    audio_array = np.squeeze(audio_array.astype(np.float32))

    pitch_steps = -5.5
    audio_array = librosa.effects.pitch_shift(y = audio_array, sr=SAMPLE_RATE, n_steps=pitch_steps)

    volume = 1.5
    audio_array = np.clip(audio_array * volume, -1.0, 1.0)

    return audio_array

def save_audio(audio_array: np.ndarray, output_file: Path) -> None:
    sf.write(output_file, audio_array, samplerate=SAMPLE_RATE)

def generate_audio(text: str, output_file: Path) -> Path:
    started_at = perf_counter()

    generator = pipeline(text, voice="pm_alex", speed=0.85)

    generated_chunks: list[np.ndarray] = []

    for index, (_, phonemes, audio) in enumerate(generator):
        audio_array = (
            audio.cpu().numpy() 
            if hasattr(audio, "cpu")
            else np.asarray(audio)
        )

        generated_chunks.append(np.squeeze(audio_array).astype(np.float32))

    if not generated_chunks:
        raise RuntimeError("Kokoro não conseguiu gerar um techo de áudio")

    complete_audio = np.concatenate(generated_chunks)
    processed_audio = apply_effects(complete_audio)

    output_file.parent.mkdir(parents=True, exist_ok=True)
    save_audio(processed_audio, output_file)

    print(f"Geração total: {perf_counter() - started_at:.2f}s", flush=True)

    return output_file