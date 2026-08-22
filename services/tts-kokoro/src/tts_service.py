import json
import queue
import sys
import threading
import traceback
from pathlib import Path
from persistent_player import (
    PersistentWavePlayer,
    create_system_player,
)
from voice_engine import (
    generate_audio,
    warm_up,
)


def send_message(message: dict) -> None:
    with send_lock:
        print(
            json.dumps(message, ensure_ascii=False),
            flush=True,
        )


work_queue: queue.Queue[dict | None] = queue.Queue()
cancel_events: dict[str, threading.Event] = {}
cancel_lock = threading.Lock()
send_lock = threading.Lock()
playback_player: PersistentWavePlayer | None = None


def process_message(message: dict) -> None:
    request_id = str(message["id"])
    message_type = message.get("type")

    if message_type != "speak":
        send_message({
            "id": request_id,
            "type": "error",
            "error": "Tipo de mensagem desconhecido.",
        })
        return

    text = str(message["text"])
    output_file = Path(message["output"])

    with cancel_lock:
        cancel_event = cancel_events[request_id]

    generated_file = generate_audio(
        text=text,
        output_file=output_file,
        should_cancel=cancel_event.is_set,
    )

    send_message({
        "id": request_id,
        "type": "audio_ready",
        "path": str(generated_file.resolve()),
    })


def synthesis_worker() -> None:
    while True:
        message = work_queue.get()

        if message is None:
            return

        request_id = str(message.get("id", ""))

        try:
            process_message(message)

        except InterruptedError:
            output = message.get("output")

            if output:
                Path(str(output)).unlink(missing_ok=True)

            send_message({
                "id": request_id,
                "type": "error",
                "error": "Síntese cancelada.",
            })

        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            send_message({
                "id": request_id,
                "type": "error",
                "error": str(error),
            })

        finally:
            with cancel_lock:
                cancel_events.pop(request_id, None)


def enqueue_message(message: dict) -> None:
    request_id = str(message.get("id", ""))
    message_type = message.get("type")

    if message_type == "cancel":
        with cancel_lock:
            event = cancel_events.get(request_id)

        event and event.set()
        return

    if message_type == "play":
        if playback_player is None:
            send_message({
                "id": request_id,
                "type": "error",
                "error": "Playback persistente indisponível.",
            })
            return
        playback_player.enqueue(
            request_id,
            Path(str(message.get("path", ""))),
        )
        return

    if message_type == "cancel_playback":
        if playback_player is not None:
            playback_player.cancel(request_id)
        return

    if message_type == "flush_playback":
        flushed = playback_player.flush() if playback_player is not None else 0
        send_message({
            "id": request_id,
            "type": "playback_flushed",
            "count": flushed,
        })
        return

    if message_type != "speak":
        send_message({
            "id": request_id,
            "type": "error",
            "error": "Tipo de mensagem desconhecido.",
        })
        return

    with cancel_lock:
        cancel_events[request_id] = threading.Event()

    work_queue.put(message)


def main() -> None:
    global playback_player
    warm_up()

    playback_player = create_system_player(send_message)

    worker = threading.Thread(
        target=synthesis_worker,
        daemon=True,
    )
    worker.start()

    send_message({
        "type": "ready",
        "capabilities": [
            "synthesis-v1",
            *(["playback-v1"] if playback_player is not None else []),
        ],
    })

    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        message = None

        try:
            message = json.loads(line)
            enqueue_message(message)

        except Exception as error:
            traceback.print_exc(
                file=sys.stderr
            )

            send_message({
                "id": (
                    message.get("id")
                    if message
                    else None
                ),
                "type": "error",
                "error": str(error),
            })

    work_queue.put(None)
    if playback_player is not None:
        playback_player.close()


if __name__ == "__main__":
    main()
