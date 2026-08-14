from pathlib import Path
from time import perf_counter
import os
import sys

import librosa
import numpy as np
import soundfile as sf
from kokoro import KPipeline


SAMPLE_RATE = 24000
VOICE = os.getenv("ULTRON_TTS_VOICE", "pm_alex")
SPEED = float(os.getenv("ULTRON_TTS_SPEED", "0.85"))
PITCH_STEPS = float(os.getenv("ULTRON_TTS_PITCH_STEPS", "-5.5"))
DEBUG = os.getenv("ULTRON_DEBUG", "0") == "1"


def log(message: str) -> None:
    if not DEBUG:
        return

    print(
        f"[TTS PERF] {message}",
        file=sys.stderr,
        flush=True,
    )

pipeline_started_at = perf_counter()

pipeline = KPipeline(
    lang_code="p",
)

log(
    f"KPipeline initialization: "
    f"{perf_counter() - pipeline_started_at:.2f}s"
)

def apply_effects(
    audio: np.ndarray,
) -> np.ndarray:
    started_at = perf_counter()

    audio_array = (
        audio.cpu().numpy()
        if hasattr(audio, "cpu")
        else np.asarray(audio)
    )

    audio_array = np.squeeze(
        audio_array.astype(np.float32)
    )

    conversion_elapsed = (
        perf_counter() - started_at
    )

    pitch_elapsed = 0.0

    if PITCH_STEPS:
        pitch_started_at = perf_counter()

        audio_array = librosa.effects.pitch_shift(
            y=audio_array,
            sr=SAMPLE_RATE,
            n_steps=PITCH_STEPS,
        )

        pitch_elapsed = (
            perf_counter() - pitch_started_at
        )

    volume_started_at = perf_counter()

    audio_array = np.clip(
        audio_array * 1.5,
        -1.0,
        1.0,
    )

    volume_elapsed = (
        perf_counter() - volume_started_at
    )

    log(
        "Effects: "
        f"conversion={conversion_elapsed:.3f}s | "
        f"pitch={pitch_elapsed:.3f}s | "
        f"volume={volume_elapsed:.3f}s"
    )

    return audio_array

def save_audio(
    audio_array: np.ndarray,
    output_file: Path,
) -> None:
    started_at = perf_counter()

    sf.write(
        output_file,
        audio_array,
        samplerate=SAMPLE_RATE,
    )

    log(
        f"Disk write: "
        f"{perf_counter() - started_at:.3f}s"
    )

def generate_audio(
    text: str,
    output_file: Path,
) -> Path:
    total_started_at = perf_counter()

    generator_started_at = perf_counter()

    generator = pipeline(
        text,
        voice=VOICE,
        speed=SPEED,
    )

    log(
        f"Generator creation: "
        f"{perf_counter() - generator_started_at:.3f}s"
    )

    generated_chunks: list[np.ndarray] = []

    kokoro_started_at = perf_counter()

    for _, _, audio in generator:
        audio_array = (
            audio.cpu().numpy()
            if hasattr(audio, "cpu")
            else np.asarray(audio)
        )

        generated_chunks.append(
            np.squeeze(audio_array).astype(
                np.float32
            )
        )

    kokoro_elapsed = (
        perf_counter() - kokoro_started_at
    )

    log(
        f"Kokoro generation: "
        f"{kokoro_elapsed:.3f}s"
    )

    if not generated_chunks:
        raise RuntimeError(
            "Kokoro não conseguiu gerar "
            "um trecho de áudio"
        )

    concat_started_at = perf_counter()

    complete_audio = np.concatenate(
        generated_chunks
    )

    log(
        f"Concatenate: "
        f"{perf_counter() - concat_started_at:.3f}s"
    )

    processed_audio = apply_effects(
        complete_audio
    )

    output_file.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    save_audio(
        processed_audio,
        output_file,
    )

    log(
        f"TOTAL: "
        f"{perf_counter() - total_started_at:.3f}s"
    )

    return output_file

def warm_up() -> None:
    started_at = perf_counter()

    log("Starting warm-up...")

    kokoro_started_at = perf_counter()

    generator = pipeline(
        "Sistema pronto.",
        voice=VOICE,
        speed=SPEED,
    )

    generated_chunks: list[np.ndarray] = []

    for _, _, audio in generator:
        audio_array = (
            audio.cpu().numpy()
            if hasattr(audio, "cpu")
            else np.asarray(audio)
        )

        generated_chunks.append(
            np.squeeze(audio_array).astype(
                np.float32
            )
        )

    log(
        f"Kokoro warm-up: "
        f"{perf_counter() - kokoro_started_at:.3f}s"
    )

    if generated_chunks and PITCH_STEPS:
        effects_started_at = perf_counter()

        sample = generated_chunks[0]

        # Não precisamos processar todo o áudio.
        # Um pequeno trecho já força o librosa/numba
        # a inicializar o código necessário.
        sample_size = min(
            len(sample),
            SAMPLE_RATE,
        )

        sample = sample[:sample_size]

        librosa.effects.pitch_shift(
            y=sample,
            sr=SAMPLE_RATE,
            n_steps=PITCH_STEPS,
        )

        log(
            f"Effects warm-up: "
            f"{perf_counter() - effects_started_at:.3f}s"
        )

    log(
        f"Warm-up completed: "
        f"{perf_counter() - started_at:.3f}s"
    )
