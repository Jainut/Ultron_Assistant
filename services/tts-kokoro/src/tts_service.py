import json
import sys
import traceback
from pathlib import Path

from voice_engine import generate_audio


def send_message(message: dict) -> None:
    print(
        json.dumps(message, ensure_ascii=False),
        flush=True,
    )


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

    generated_file = generate_audio(
        text=text,
        output_file=output_file,
    )

    send_message({
        "id": request_id,
        "type": "audio_ready",
        "path": str(generated_file.resolve()),
    })


def main() -> None:
    send_message({
        "type": "ready",
    })

    for line in sys.stdin:
        line = line.strip()

        if not line:
            continue

        message = None

        try:
            message = json.loads(line)
            process_message(message)

        except Exception as error:
            traceback.print_exc(file=sys.stderr)

            send_message({
                "id": message.get("id") if message else None,
                "type": "error",
                "error": str(error),
            })


if __name__ == "__main__":
    main()