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
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import sounddevice as sd

from endpointing import AdaptiveEndpoint, EndpointingConfig
from playback_echo_reference import EchoReferenceConfig, PlaybackEchoReference

try:
    import webrtcvad  # type: ignore[import-not-found]
except ImportError:
    webrtcvad = None


CONFIGURED_INPUT_DEVICE = os.getenv("ULTRON_INPUT_DEVICE", "17").strip()
INPUT_DEVICE = int(CONFIGURED_INPUT_DEVICE) if CONFIGURED_INPUT_DEVICE else None
SAMPLE_RATE = int(os.getenv("ULTRON_SAMPLE_RATE", "48000"))

BLOCK_DURATION = 0.05
BLOCK_SIZE = int(SAMPLE_RATE * BLOCK_DURATION)

SPEECH_THRESHOLD = float(os.getenv("ULTRON_SPEECH_THRESHOLD", "0.015"))
BARGE_SPEECH_THRESHOLD = float(
    os.getenv("ULTRON_BARGE_SPEECH_THRESHOLD", "0.035")
)

PRE_ROLL_SECONDS = 0.30

ENDPOINT_MIN_SECONDS = float(
    os.getenv("ULTRON_ENDPOINT_MIN_MS", "280")
) / 1000.0
ENDPOINT_MAX_SECONDS = float(
    os.getenv("ULTRON_ENDPOINT_MAX_MS", "400")
) / 1000.0
LEGACY_SILENCE_SECONDS = os.getenv("ULTRON_SILENCE_SECONDS")
DEFAULT_ENDPOINT_TARGET_SECONDS = (
    float(LEGACY_SILENCE_SECONDS)
    if LEGACY_SILENCE_SECONDS
    else 0.32
)
ENDPOINT_TARGET_SECONDS = float(
    os.getenv(
        "ULTRON_ENDPOINT_TARGET_MS",
        str(DEFAULT_ENDPOINT_TARGET_SECONDS * 1000.0),
    )
) / 1000.0
ENDPOINT_TARGET_SECONDS = min(
    ENDPOINT_MAX_SECONDS,
    max(ENDPOINT_MIN_SECONDS, ENDPOINT_TARGET_SECONDS),
)

LEGACY_MIN_SPEECH_SECONDS = os.getenv("ULTRON_MIN_SPEECH_SECONDS")
CONFIGURED_MIN_VOICED_MS = os.getenv("ULTRON_MIN_VOICED_MS")
MIN_VOICED_SECONDS = float(os.getenv(
    "ULTRON_MIN_VOICED_SECONDS",
    (
        str(float(CONFIGURED_MIN_VOICED_MS) / 1000.0)
        if CONFIGURED_MIN_VOICED_MS
        else LEGACY_MIN_SPEECH_SECONDS or "0.12"
    ),
))
MAX_SPEECH_SECONDS = float(os.getenv("ULTRON_MAX_SPEECH_SECONDS", "20.0"))
BARGE_START_BLOCKS = max(
    1,
    int(os.getenv("ULTRON_BARGE_START_BLOCKS", "2")),
)

PRE_ROLL_BLOCKS = int(
    PRE_ROLL_SECONDS / BLOCK_DURATION
)

ENDPOINT_CONFIG = EndpointingConfig(
    block_seconds=BLOCK_DURATION,
    minimum_silence_seconds=ENDPOINT_MIN_SECONDS,
    target_silence_seconds=ENDPOINT_TARGET_SECONDS,
    maximum_silence_seconds=ENDPOINT_MAX_SECONDS,
)

VAD_ENABLED = os.getenv("ULTRON_VAD_ENABLED", "1").strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}
VAD_MODE = max(0, min(3, int(os.getenv("ULTRON_VAD_MODE", "2"))))
VAD_RMS_GATE_RATIO = max(
    0.0,
    min(1.0, float(os.getenv("ULTRON_VAD_RMS_GATE_RATIO", "1.0"))),
)

ECHO_REFERENCE_ENABLED = os.getenv(
    "ULTRON_ECHO_REFERENCE_ENABLED",
    "1",
).strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}
ECHO_DELAY_MIN_MS = max(
    0.0,
    min(500.0, float(os.getenv("ULTRON_ECHO_DELAY_MIN_MS", "0"))),
)
ECHO_DELAY_MAX_MS = max(
    ECHO_DELAY_MIN_MS,
    min(500.0, float(os.getenv("ULTRON_ECHO_DELAY_MAX_MS", "250"))),
)
ECHO_DELAY_STEP_MS = max(
    2.5,
    min(50.0, float(os.getenv("ULTRON_ECHO_DELAY_STEP_MS", "5"))),
)
ECHO_CORRELATION_THRESHOLD = max(
    0.95,
    min(
        0.999,
        float(os.getenv("ULTRON_ECHO_CORRELATION_THRESHOLD", "0.97")),
    ),
)
ECHO_RESIDUAL_RATIO_THRESHOLD = max(
    0.05,
    min(
        0.25,
        float(os.getenv("ULTRON_ECHO_RESIDUAL_RATIO_THRESHOLD", "0.18")),
    ),
)
ECHO_MIN_REFERENCE_RMS = max(
    0.0001,
    min(0.10, float(os.getenv("ULTRON_ECHO_MIN_REFERENCE_RMS", "0.002"))),
)
ECHO_MAX_WAV_MB = max(
    1.0,
    min(128.0, float(os.getenv("ULTRON_ECHO_MAX_WAV_MB", "64"))),
)
ECHO_MAX_REFERENCE_SECONDS = max(
    1.0,
    min(
        300.0,
        float(os.getenv("ULTRON_ECHO_MAX_REFERENCE_SECONDS", "120")),
    ),
)
ECHO_EXPIRY_GRACE_MS = max(
    0.0,
    min(10000.0, float(os.getenv("ULTRON_ECHO_EXPIRY_GRACE_MS", "1500"))),
)
ECHO_MAX_START_AGE_MS = max(
    0.0,
    min(1000.0, float(os.getenv("ULTRON_ECHO_MAX_START_AGE_MS", "500"))),
)
ECHO_TELEMETRY_INTERVAL_MS = max(
    250.0,
    min(
        10000.0,
        float(os.getenv("ULTRON_ECHO_TELEMETRY_INTERVAL_MS", "1000")),
    ),
)

ECHO_REFERENCE_CONFIG = EchoReferenceConfig(
    sample_rate=SAMPLE_RATE,
    minimum_delay_ms=ECHO_DELAY_MIN_MS,
    maximum_delay_ms=ECHO_DELAY_MAX_MS,
    delay_step_ms=ECHO_DELAY_STEP_MS,
    correlation_threshold=ECHO_CORRELATION_THRESHOLD,
    residual_ratio_threshold=ECHO_RESIDUAL_RATIO_THRESHOLD,
    minimum_reference_rms=ECHO_MIN_REFERENCE_RMS,
    maximum_wav_bytes=round(ECHO_MAX_WAV_MB * 1024 * 1024),
    maximum_reference_seconds=ECHO_MAX_REFERENCE_SECONDS,
    expiry_grace_ms=ECHO_EXPIRY_GRACE_MS,
    maximum_start_age_ms=ECHO_MAX_START_AGE_MS,
)


audio_queue: queue.Queue[tuple[np.ndarray, float]] = queue.Queue()
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

    # Timestamp at the audio boundary, not when the main loop eventually
    # consumes the queue. Control handling/reference loading can otherwise
    # shift acoustic alignment by its processing time.
    mono_block = indata[:, 0].copy()
    captured_at_monotonic_ms = time.monotonic() * 1000.0
    block_started_monotonic_ms = (
        captured_at_monotonic_ms
        - len(mono_block) * 1000.0 / SAMPLE_RATE
    )
    audio_queue.put((
        mono_block,
        block_started_monotonic_ms,
    ))


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


class SpeechDetector:
    """WebRTC VAD when available, with the existing RMS detector as fallback."""

    def __init__(self) -> None:
        self._vad = None
        self.name = "rms"

        if (
            VAD_ENABLED
            and webrtcvad is not None
            and SAMPLE_RATE in {8000, 16000, 32000, 48000}
        ):
            try:
                self._vad = webrtcvad.Vad(VAD_MODE)
                self.name = "webrtcvad"
            except Exception:
                self._vad = None

    def is_speech(
        self,
        audio: np.ndarray,
        rms: float,
        rms_threshold: float,
    ) -> bool:
        if self._vad is None:
            return rms >= rms_threshold

        try:
            pcm = (
                np.clip(audio, -1.0, 1.0) * 32767
            ).astype(np.int16)
            frame_samples = int(SAMPLE_RATE * 0.01)
            frame_count = len(pcm) // frame_samples
            if frame_count == 0:
                return rms >= rms_threshold

            voiced_frames = 0
            for frame_index in range(frame_count):
                start = frame_index * frame_samples
                frame = pcm[start:start + frame_samples]
                if self._vad.is_speech(frame.tobytes(), SAMPLE_RATE):
                    voiced_frames += 1

            required_frames = max(1, (frame_count + 1) // 2)
            return (
                voiced_frames >= required_frames
                and rms >= rms_threshold * VAD_RMS_GATE_RATIO
            )
        except Exception:
            # A runtime/frame incompatibility must degrade capture, not stop it.
            self._vad = None
            self.name = "rms"
            return rms >= rms_threshold


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


@contextmanager
def open_input_stream():
    devices = sd.query_devices()
    default_input = sd.default.device[0]
    candidates = [INPUT_DEVICE, default_input]
    candidates.extend(
        index
        for index, device in enumerate(devices)
        if (
            device["max_input_channels"] > 0
            and any(
                term in str(device["name"]).lower()
                for term in ("microfone", "microphone", "mic ")
            )
            and not any(
                term in str(device["name"]).lower()
                for term in ("mixagem", "stereo input", "stream", "midi")
            )
        )
    )
    unique_candidates = list(dict.fromkeys(
        candidate
        for candidate in candidates
        if candidate is not None and candidate >= 0
    ))
    last_error = None
    stream = None
    selected_device = None

    for candidate in unique_candidates:
        try:
            stream = sd.InputStream(
                device=candidate,
                samplerate=SAMPLE_RATE,
                blocksize=BLOCK_SIZE,
                dtype="float32",
                channels=1,
                callback=audio_callback,
            )
            stream.start()
            selected_device = candidate
            break

        except sd.PortAudioError as error:
            last_error = error

            if stream is not None:
                stream.close()
                stream = None

    if stream is None:
        raise RuntimeError(
            "Nenhum dispositivo de entrada de áudio pôde ser aberto."
        ) from last_error

    try:
        send_message({
            "type": "input_device",
            "device": selected_device,
            "name": devices[selected_device]["name"],
            "fallback": selected_device != INPUT_DEVICE,
        })
        yield stream

    finally:
        stream.stop()
        stream.close()


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

    endpoint = AdaptiveEndpoint(ENDPOINT_CONFIG)
    speech_detector = SpeechDetector()
    echo_reference = PlaybackEchoReference(ECHO_REFERENCE_CONFIG)

    speech_started_at: (
        float | None
    ) = None
    playback_active = False
    speech_candidate_blocks = 0
    last_echo_telemetry_at = 0.0

    with open_input_stream():
        send_message({
            "type": "ready",
            "detector": speech_detector.name,
            "endpoint": {
                "minimumMs": round(ENDPOINT_MIN_SECONDS * 1000),
                "targetMs": round(ENDPOINT_TARGET_SECONDS * 1000),
                "maximumMs": round(ENDPOINT_MAX_SECONDS * 1000),
            },
            "echoReference": {
                "enabled": ECHO_REFERENCE_ENABLED,
                "maximumDelayMs": ECHO_DELAY_MAX_MS,
                "correlationThreshold": ECHO_CORRELATION_THRESHOLD,
                "residualRatioThreshold": ECHO_RESIDUAL_RATIO_THRESHOLD,
            },
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

                    endpoint.reset()
                    speech_started_at = None
                    speech_candidate_blocks = 0

                    clear_audio_queue()

                elif control_type == "resume":
                    paused = False

                    recording = False
                    recorded_blocks.clear()
                    pre_roll.clear()

                    endpoint.reset()
                    speech_started_at = None
                    speech_candidate_blocks = 0

                    clear_audio_queue()

                elif control_type == "stop":
                    running = False
                    break

                elif control_type == "playback":
                    playback_active = bool(control.get("active", False))
                    speech_candidate_blocks = 0
                    if not playback_active:
                        echo_reference.clear()

                elif control_type == "playback_reference_start":
                    if ECHO_REFERENCE_ENABLED:
                        echo_reference.start(
                            control.get("path", ""),
                            control.get("generation"),
                            control.get("startedAtUnixMs"),
                        )

                elif control_type == "playback_reference_end":
                    generation = control.get("generation")
                    if (
                        isinstance(generation, int)
                        and not isinstance(generation, bool)
                    ):
                        echo_reference.end(generation)


            if not running:
                break


            # =========================
            # CAPTURA
            # =========================

            try:
                block, block_started_monotonic_ms = audio_queue.get(
                    timeout=0.1
                )

            except queue.Empty:
                continue


            if paused:
                continue

            evaluation_now_monotonic_ms = time.monotonic() * 1000.0
            block_duration_ms = len(block) * 1000.0 / SAMPLE_RATE
            queue_age_ms = max(
                0.0,
                evaluation_now_monotonic_ms
                - (block_started_monotonic_ms + block_duration_ms),
            )


            rms = calculate_rms(
                block
            )

            active_threshold = (
                BARGE_SPEECH_THRESHOLD
                if playback_active
                else SPEECH_THRESHOLD
            )
            is_speech = speech_detector.is_speech(
                block,
                rms,
                active_threshold,
            )


            # =========================
            # ESPERANDO FALA
            # =========================

            if not recording:
                if (
                    ECHO_REFERENCE_ENABLED
                    and playback_active
                    and is_speech
                ):
                    echo_decision = echo_reference.evaluate(
                        block,
                        block_started_at_monotonic_ms=(
                            block_started_monotonic_ms
                        ),
                        now_monotonic_ms=evaluation_now_monotonic_ms,
                    )
                    if echo_decision.suppressed:
                        # Preserve pre-roll duration without sending the
                        # assistant's reference audio back to Whisper.
                        pre_roll.append(np.zeros_like(block))
                        speech_candidate_blocks = 0

                        if (
                            evaluation_now_monotonic_ms
                            - last_echo_telemetry_at
                            >= ECHO_TELEMETRY_INTERVAL_MS
                            and echo_decision.generation >= 0
                            and all(np.isfinite(value) for value in (
                                echo_decision.correlation,
                                echo_decision.residual_ratio,
                                echo_decision.delay_ms,
                                echo_decision.processing_ms,
                                queue_age_ms,
                            ))
                        ):
                            last_echo_telemetry_at = (
                                evaluation_now_monotonic_ms
                            )
                            send_message({
                                "type": "echo_suppressed",
                                "correlation": round(
                                    echo_decision.correlation,
                                    4,
                                ),
                                "residualRatio": round(
                                    echo_decision.residual_ratio,
                                    4,
                                ),
                                "delayMs": round(
                                    echo_decision.delay_ms,
                                    2,
                                ),
                                "generation": echo_decision.generation,
                                "processingMs": round(
                                    echo_decision.processing_ms,
                                    3,
                                ),
                                "queueAgeMs": round(queue_age_ms, 3),
                            })
                        continue

                pre_roll.append(
                    block
                )

                if not is_speech:
                    speech_candidate_blocks = 0
                    continue

                speech_candidate_blocks += 1

                if (
                    playback_active
                    and speech_candidate_blocks < BARGE_START_BLOCKS
                ):
                    continue

                recording = True
                starting_voiced_blocks = speech_candidate_blocks
                speech_candidate_blocks = 0

                endpoint.reset()
                for _ in range(starting_voiced_blocks):
                    endpoint.observe(True)

                speech_started_at = (
                    time.monotonic()
                )

                recorded_blocks.extend(
                    list(pre_roll)
                )

                pre_roll.clear()

                send_message({
                    "type": "speech_start",
                    "rms": rms,
                    "playback": playback_active,
                    "detector": speech_detector.name,
                })

                continue


            # =========================
            # GRAVANDO
            # =========================

            recorded_blocks.append(
                block
            )

            endpoint_decision = endpoint.observe(is_speech)


            if speech_started_at is None:
                duration = 0.0

            else:
                duration = (
                    time.monotonic()
                    - speech_started_at
                )


            finished_by_silence = (
                endpoint_decision.finished
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
                endpoint_decision.voiced_seconds
                < MIN_VOICED_SECONDS
            ):
                recorded_blocks.clear()
                pre_roll.clear()

                endpoint.reset()
                speech_started_at = None

                send_message({
                    "type": "speech_end",
                    "reason": "discarded",
                    "speechDurationMs": round(duration * 1000),
                    "voicedDurationMs": round(
                        endpoint_decision.voiced_seconds * 1000
                    ),
                    "endpointDelayMs": round(
                        endpoint_decision.trailing_silence_seconds * 1000
                    ),
                    "silenceTargetMs": round(
                        endpoint_decision.required_silence_seconds * 1000
                    ),
                    "detector": speech_detector.name,
                })

                continue


            endpoint_metrics = {
                "reason": (
                    "silence"
                    if finished_by_silence
                    else "timeout"
                ),
                "speechDurationMs": round(duration * 1000),
                "voicedDurationMs": round(
                    endpoint_decision.voiced_seconds * 1000
                ),
                "endpointDelayMs": round(
                    endpoint_decision.trailing_silence_seconds * 1000
                ),
                "silenceTargetMs": round(
                    endpoint_decision.required_silence_seconds * 1000
                ),
                "detector": speech_detector.name,
            }

            send_message({
                "type": "speech_end",
                **endpoint_metrics,
            })


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
                "endpoint": endpoint_metrics,
            })


            recorded_blocks.clear()
            pre_roll.clear()

            endpoint.reset()
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
