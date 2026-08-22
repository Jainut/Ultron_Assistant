"""Reproducible control-plane benchmark; it never opens an audio device."""

from pathlib import Path
from tempfile import TemporaryDirectory
import argparse
import json
import math
import statistics
import subprocess
import sys
import threading
import time

from persistent_player import PersistentWavePlayer


def summarize(samples: list[float]) -> dict[str, float]:
    ordered = sorted(samples)
    p95_index = min(len(ordered) - 1, math.ceil(len(ordered) * 0.95) - 1)
    return {
        "mean_ms": round(statistics.fmean(ordered), 3),
        "p50_ms": round(statistics.median(ordered), 3),
        "p95_ms": round(ordered[p95_index], 3),
        "min_ms": round(ordered[0], 3),
        "max_ms": round(ordered[-1], 3),
    }


def legacy_samples(iterations: int) -> list[float]:
    command = [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$null = New-Object System.Media.SoundPlayer",
    ]
    samples: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        subprocess.run(
            command,
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        samples.append((time.perf_counter() - started) * 1000)
    return samples


def persistent_samples(iterations: int) -> list[float]:
    with TemporaryDirectory(prefix="ultron-player-bench-") as root:
        fixture = Path(root, "fixture.wav")
        # The injected no-op backend means this need not be a valid WAV.
        fixture.write_bytes(b"fixture")
        worker = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        if worker.stdin is None or worker.stdout is None:
            raise RuntimeError("Não foi possível abrir os pipes do benchmark.")
        ready = json.loads(worker.stdout.readline())
        if ready.get("type") != "ready":
            raise RuntimeError(f"Worker não iniciou: {ready!r}")

        samples: list[float] = []
        try:
            for index in range(iterations):
                request_id = f"bench-{index}"
                started = time.perf_counter()
                worker.stdin.write(json.dumps({
                    "id": request_id,
                    "path": str(fixture),
                }) + "\n")
                worker.stdin.flush()
                while True:
                    line = worker.stdout.readline()
                    if not line:
                        raise RuntimeError("Worker persistente encerrou prematuramente.")
                    event = json.loads(line)
                    if (
                        event.get("id") == request_id
                        and event.get("type") == "playback_finished"
                    ):
                        break
                samples.append((time.perf_counter() - started) * 1000)
        finally:
            worker.stdin.close()
            worker.wait(timeout=2.0)
        return samples


def worker_main() -> None:
    output_lock = threading.Lock()

    def emit(event: dict[str, object]) -> None:
        with output_lock:
            print(json.dumps(event), flush=True)

    player = PersistentWavePlayer(
        emit,
        start_sound=lambda _path: 0.0,
        stop_sound=lambda: None,
    )
    print(json.dumps({"type": "ready"}), flush=True)
    try:
        for line in sys.stdin:
            message = json.loads(line)
            player.enqueue(str(message["id"]), Path(str(message["path"])))
    finally:
        player.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=20)
    args = parser.parse_args()
    if args.iterations < 3:
        parser.error("--iterations deve ser pelo menos 3")

    result = {
        "iterations": args.iterations,
        "measurement": "control-plane only; no real audio",
        "legacy_powershell_per_chunk": summarize(legacy_samples(args.iterations)),
        "persistent_json_protocol_round_trip": summarize(persistent_samples(args.iterations)),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    if "--worker" in sys.argv:
        worker_main()
    else:
        main()
