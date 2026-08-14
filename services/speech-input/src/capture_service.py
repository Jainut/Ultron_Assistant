from __future__ import annotations

import json
import os
import queue
import sys
import tempfile
import threading
import time
import wave
from collections import deque
from pathlib import Path

import numpy as np
import sounddevice as sd


INPUT_DEVICE = int(os.getenv("ULTRON_INPUT_DEVICE", "17"))
SAMPLE_RATE = int(os.getenv("ULTRON_SAMPLE_RATE", "48000"))

BLOCK_DURATION = 0.05
BLOCK_SIZE = int(SAMPLE_RATE * BLOCK_DURATION)

SPEECH_THRESHOLD = float(os.getenv("ULTRON_SPEECH_THRESHOLD", "0.015"))

PRE_ROLL_SECONDS = 0.30
SILENCE_SECONDS = float(os.getenv("ULTRON_SILENCE_SECONDS", "0.75"))

MIN_SPEECH_SECONDS = 0.25
MAX_SPEECH_SECONDS = 20.0

PRE_ROLL_BLOCKS = int(
    PRE_ROLL_SECONDS / BLOCK_DURATION
)

SILENCE_BLOCKS = int(
    SILENCE_SECONDS / BLOCK_DURATION
)


audio_queue: queue.Queue[np.ndarray] = queue.Queue()
control_queue: queue.Queue[dict] = queue.Queue()

running = True
paused = True


TEMP_DIR = (
    Path(tempfile.gettempdir())
    / "ultron-stt"
)

TEMP_DIR.mkdir(
    parents=True,
    exist_ok=True,
)


def send_message(message: dict) -> None:
    print(
        json.dumps(
            message,
            ensure_ascii=False,
        ),
        flush=True,
    )


def audio_callback(
    indata,
    frames,
    time_info,
    status,
) -> None:
    if status:
        print(
            f"[audio] {status}",
            file=sys.stderr,
            flush=True,
        )

    audio_queue.put(
        indata[:, 0].copy()
    )


def read_controls() -> None:
    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        try:
            message = json.loads(line)

        except json.JSONDecodeError as error:
            send_message({
                "type": "error",
                "error": (
                    f"Controle JSON inválido: {error}"
                ),
            })

            continue

        control_queue.put(
            message
        )


def clear_audio_queue() -> None:
    while True:
        try:
            audio_queue.get_nowait()

        except queue.Empty:
            break


def calculate_rms(
    audio: np.ndarray,
) -> float:
    if len(audio) == 0:
        return 0.0

    return float(
        np.sqrt(
            np.mean(
                np.square(audio)
            )
        )
    )


def save_wav(
    audio: np.ndarray,
) -> Path:
    filename = (
        TEMP_DIR
        / f"speech-{time.time_ns()}.wav"
    )

    audio = np.clip(
        audio,
        -1.0,
        1.0,
    )

    pcm = (
        audio * 32767
    ).astype(np.int16)

    with wave.open(
        str(filename),
        "wb",
    ) as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)

        wav.writeframes(
            pcm.tobytes()
        )

    return filename


def main() -> None:
    global running
    global paused

    control_thread = threading.Thread(
        target=read_controls,
        daemon=True,
    )

    control_thread.start()

    pre_roll: deque[np.ndarray] = deque(
        maxlen=PRE_ROLL_BLOCKS
    )

    recording = False

    recorded_blocks: list[
        np.ndarray
    ] = []

    silence_counter = 0

    speech_started_at: (
        float | None
    ) = None

    with sd.InputStream(
        device=INPUT_DEVICE,
        samplerate=SAMPLE_RATE,
        blocksize=BLOCK_SIZE,
        dtype="float32",
        channels=1,
        callback=audio_callback,
    ):
        send_message({
            "type": "ready",
        })

        while running:

            # =========================
            # CONTROLES
            # =========================

            while not control_queue.empty():
                control = (
                    control_queue.get_nowait()
                )

                control_type = (
                    control.get("type")
                )

                if control_type == "pause":
                    paused = True

                    recording = False
                    recorded_blocks.clear()
                    pre_roll.clear()

                    silence_counter = 0
                    speech_started_at = None

                    clear_audio_queue()

                elif control_type == "resume":
                    paused = False

                    recording = False
                    recorded_blocks.clear()
                    pre_roll.clear()

                    silence_counter = 0
                    speech_started_at = None

                    clear_audio_queue()

                elif control_type == "stop":
                    running = False
                    break


            if not running:
                break


            # =========================
            # CAPTURA
            # =========================

            try:
                block = audio_queue.get(
                    timeout=0.1
                )

            except queue.Empty:
                continue


            if paused:
                continue


            rms = calculate_rms(
                block
            )

            is_speech = (
                rms >= SPEECH_THRESHOLD
            )


            # =========================
            # ESPERANDO FALA
            # =========================

            if not recording:
                pre_roll.append(
                    block
                )

                if not is_speech:
                    continue

                recording = True

                silence_counter = 0

                speech_started_at = (
                    time.monotonic()
                )

                recorded_blocks.extend(
                    list(pre_roll)
                )

                pre_roll.clear()

                continue


            # =========================
            # GRAVANDO
            # =========================

            recorded_blocks.append(
                block
            )

            if is_speech:
                silence_counter = 0

            else:
                silence_counter += 1


            if speech_started_at is None:
                duration = 0.0

            else:
                duration = (
                    time.monotonic()
                    - speech_started_at
                )


            finished_by_silence = (
                silence_counter
                >= SILENCE_BLOCKS
            )

            finished_by_timeout = (
                duration
                >= MAX_SPEECH_SECONDS
            )


            if not (
                finished_by_silence
                or finished_by_timeout
            ):
                continue


            # =========================
            # FINALIZA FRASE
            # =========================

            recording = False


            if (
                duration
                < MIN_SPEECH_SECONDS
            ):
                recorded_blocks.clear()
                pre_roll.clear()

                silence_counter = 0
                speech_started_at = None

                continue


            audio = np.concatenate(
                recorded_blocks
            )

            wav_path = save_wav(
                audio
            )


            # Pausa antes de entregar
            # para o Whisper.
            #
            # Assim o microfone não pega
            # a resposta do Kokoro.
            paused = True

            clear_audio_queue()


            send_message({
                "type": "audio",
                "path": str(wav_path),
            })


            recorded_blocks.clear()
            pre_roll.clear()

            silence_counter = 0
            speech_started_at = None


if __name__ == "__main__":
    try:
        main()

    except KeyboardInterrupt:
        pass

    except Exception as error:
        send_message({
            "type": "error",
            "error": str(error),
        })

        raise
