from __future__ import annotations
import json
import queue
import sys
import threading
import time
import unicodedata
from pathlib import Path
import sounddevice as sd
from vosk import KaldiRecognizer, Model, SetLogLevel

ROOT_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = (ROOT_DIR/"models"/"vosk-model-small-pt-0.3")
INPUT_DEVICE = 17
SAMPLE_RATE = 48000
BLOCK_SIZE = int(SAMPLE_RATE * 0.25)
COMMAND_TIMEOUT_SECONDS = 8

WAKE_GRAMMAR = [
    "ultron",
    "o tronco",
    "o trono",
    "o tom",
    "o tron",
    "ultra",
    "[unk]",
]

WAKE_EXPRESSIONS = [
    "ultron",
    "o tronco",
    "o trono",
    "o tom",
    "o tron",
    "ultra",
]

def debug_log(message: str) -> None:
    if DEBUG:
        print(
            message,
            file=sys.stderr,
            flush=True,
        )

DEBUG = False

audio_queue: queue.Queue[bytes] = queue.Queue()
control_queue: queue.Queue[dict] = queue.Queue()

def send_message(message: dict) -> None:
    print(json.dumps(message, ensure_ascii=False), flush=True)

def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text.lower().strip())

    return "".join(character for character in normalized if unicodedata.category(character)!="Mn")

def contains_wake_word(text: str) -> bool:
    normalized_text = normalize_text(text)

    return any(
        normalize_text(expression)
        == normalized_text
        for expression in WAKE_EXPRESSIONS
    )

    return any(
        normalize_text(expression) in normalized_text
        for expression in WAKE_EXPRESSIONS
    )

def audio_callback(indata, frames, time_info, status) -> None:
    if status:
        print(f"[áudio] {status}", file = sys.stderr, flush=True)
    audio_queue.put(bytes(indata))

def read_controls() -> None:
    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue
        try:
            control_queue.put(json.loads(line))
        except json.JSONDecodeError as error:
            send_message({
                "type": "error", 
                "error": f"Controle JSON inválido {error}"
            })

def create_wake_recognizer(
    model: Model,
) -> KaldiRecognizer:
    grammar = json.dumps(
        WAKE_GRAMMAR,
        ensure_ascii=False,
    )

    return KaldiRecognizer(
        model,
        SAMPLE_RATE,
        grammar,
    )

def create_command_recognizer(model: Model) -> KaldiRecognizer:
    return KaldiRecognizer(model, SAMPLE_RATE)

def clear_audio_queue() -> None:
    while not audio_queue.empty():
        try:
            audio_queue.get_nowait()
        except queue.Empty:
            break

def main() -> None:
    SetLogLevel(-1)

    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Modelo não encontrado {MODEL_PATH}")
    
    model = Model(str(MODEL_PATH))
    wake_recognizer = create_wake_recognizer(model)
    command_recognizer = create_command_recognizer(model)
    mode = "wake"
    command_deadline: float | None = None
    control_thread = threading.Thread(target = read_controls, daemon=True)

    control_thread.start()

    with sd.RawInputStream(
        device=INPUT_DEVICE,
        samplerate=SAMPLE_RATE,
        blocksize=BLOCK_SIZE,
        dtype="int16",
        channels=1,
        callback=audio_callback
    ):
        send_message({"type": "ready"})

        while True:
            while not control_queue.empty():
                control = control_queue.get_nowait()
                control_type = control.get("type")

                if control_type == "pause":
                    mode = "paused"
                    clear_audio_queue()
                elif control_type == "resume":
                    mode = "wake"
                    wake_recognizer = create_wake_recognizer(model)
                    command_deadline = None
                    clear_audio_queue()
                elif control_type == "stop":
                    return
            
            try:
                data = audio_queue.get(timeout=0.1)
            except queue.Empty:
                if(mode == "command" and command_deadline is not None and time.monotonic() >= command_deadline):
                    final_result = json.loads(command_recognizer.FinalResult())
                    text = str(final_result.get("text", "")).strip()
                continue

            if mode == "paused":
                continue

            if mode == "wake":
                accepted = wake_recognizer.AcceptWaveform(data)

                if accepted:
                    result = json.loads(
                        wake_recognizer.Result()
                    )

                    recognized_text = str(
                        result.get("text", "")
                    ).strip()

                    result_type = "final"

                else:
                    result = json.loads(
                        wake_recognizer.PartialResult()
                    )

                    recognized_text = str(
                        result.get("partial", "")
                    ).strip()

                    result_type = "parcial"

                if not recognized_text:
                    continue

                debug_log(
                    f"[wake {result_type}] {recognized_text}",
                )

                matched = contains_wake_word(
                    recognized_text
                )

                debug_log(
                    f"[wake match] {recognized_text!r} -> {matched}",
                )

                if matched:
                    send_message({
                        "type": "wake_detected",
                        "text": recognized_text,
                    })

                    debug_log(
                        "[wake] Wake word confirmada. Aguardando comando...",
                    )

                    mode = "command"

                    command_recognizer = (
                        create_command_recognizer(model)
                    )

                    command_deadline = (
                        time.monotonic()
                        + COMMAND_TIMEOUT_SECONDS
                    )

                    clear_audio_queue()

                    debug_log(
                        "[wake] Wake word confirmada. Aguardando comando..."
                    )

                continue

            if mode == "command":
                accepted = command_recognizer.AcceptWaveform(data)

                if accepted:
                    result = json.loads(command_recognizer.Result())

                    text = str(result.get("text", "")).strip()

                    debug_log(
                        f"[command final] {text!r}",
                    )

                    if text:
                        send_message(
                            {
                                "type": "transcript",
                                "text": text,
                            }
                        )

                        mode = "paused"
                        command_deadline = None
                        clear_audio_queue()

                        continue

                else:
                    partial_result = json.loads(command_recognizer.PartialResult())

                    partial_text = str(
                        partial_result.get(
                            "partial",
                            "",
                        )
                    ).strip()

                    if partial_text:
                        debug_log(
                            f"[command parcial] {partial_text}",
                        )

                if command_deadline is not None and time.monotonic() >= command_deadline:
                    final_result = json.loads(command_recognizer.FinalResult())

                    text = str(
                        final_result.get(
                            "text",
                            "",
                        )
                    ).strip()

                    debug_log(
                        f"[command timeout] {text!r}",
                    )

                    if text:
                        send_message(
                            {
                                "type": "transcript",
                                "text": text,
                            }
                        )

                    else:
                        send_message(
                            {
                                "type": "timeout",
                            }
                        )

                    mode = "paused"
                    command_deadline = None
                    clear_audio_queue()

                    continue


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"Erro fatal no STT: {error}", file=sys.stderr, flush=True)

        send_message({
            type:"error",
            "error": str(error)
        })

        raise