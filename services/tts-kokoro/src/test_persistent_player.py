from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
import unittest

from persistent_player import PersistentWavePlayer


class EventCollector:
    def __init__(self) -> None:
        self.events: list[dict[str, object]] = []
        self.condition = threading.Condition()

    def emit(self, event: dict[str, object]) -> None:
        with self.condition:
            self.events.append(event)
            self.condition.notify_all()

    def wait_for(self, predicate, timeout: float = 1.0) -> None:
        deadline = time.monotonic() + timeout
        with self.condition:
            while not predicate(self.events):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.fail_with_events()
                self.condition.wait(remaining)

    def fail_with_events(self) -> None:
        raise AssertionError(f"Eventos esperados não chegaram: {self.events!r}")


class PersistentWavePlayerTests(unittest.TestCase):
    def test_enfileira_sem_criar_worker_por_audio(self) -> None:
        collector = EventCollector()
        played: list[str] = []

        with TemporaryDirectory(prefix="ultron-player-") as root:
            first = Path(root, "first.wav")
            second = Path(root, "second.wav")
            first.write_bytes(b"fixture")
            second.write_bytes(b"fixture")
            player = PersistentWavePlayer(
                collector.emit,
                start_sound=lambda path: played.append(path.name) or 0.0,
                stop_sound=lambda: None,
            )
            worker = player._worker  # One stable worker is the behavior under test.
            try:
                player.enqueue("play-1", first)
                player.enqueue("play-2", second)
                collector.wait_for(lambda events: len(events) == 4)

                self.assertEqual(played, ["first.wav", "second.wav"])
                self.assertIs(player._worker, worker)
                self.assertEqual(
                    [(event["id"], event["type"]) for event in collector.events],
                    [
                        ("play-1", "playback_started"),
                        ("play-1", "playback_finished"),
                        ("play-2", "playback_started"),
                        ("play-2", "playback_finished"),
                    ],
                )
            finally:
                player.close()

    def test_cancel_interrompe_playback_ativo(self) -> None:
        collector = EventCollector()
        stopped = 0

        def stop_sound() -> None:
            nonlocal stopped
            stopped += 1

        with TemporaryDirectory(prefix="ultron-player-") as root:
            audio = Path(root, "long.wav")
            audio.write_bytes(b"fixture")
            player = PersistentWavePlayer(
                collector.emit,
                start_sound=lambda _path: 30.0,
                stop_sound=stop_sound,
                poll_interval=0.001,
            )
            try:
                player.enqueue("play-long", audio)
                collector.wait_for(lambda events: any(
                    event["type"] == "playback_started" for event in events
                ))
                self.assertTrue(player.cancel("play-long"))
                collector.wait_for(lambda events: any(
                    event["type"] == "playback_cancelled" for event in events
                ))
                self.assertGreaterEqual(stopped, 1)
            finally:
                player.close()

    def test_flush_cancela_ativo_e_itens_ainda_na_fila(self) -> None:
        collector = EventCollector()
        with TemporaryDirectory(prefix="ultron-player-") as root:
            first = Path(root, "first.wav")
            second = Path(root, "second.wav")
            first.write_bytes(b"fixture")
            second.write_bytes(b"fixture")
            player = PersistentWavePlayer(
                collector.emit,
                start_sound=lambda _path: 30.0,
                stop_sound=lambda: None,
                poll_interval=0.001,
            )
            try:
                player.enqueue("play-1", first)
                player.enqueue("play-2", second)
                collector.wait_for(lambda events: any(
                    event["type"] == "playback_started" for event in events
                ))
                self.assertEqual(player.flush(), 2)
                collector.wait_for(lambda events: len([
                    event for event in events
                    if event["type"] == "playback_cancelled"
                ]) == 2)
                cancelled_ids = {
                    str(event["id"])
                    for event in collector.events
                    if event["type"] == "playback_cancelled"
                }
                self.assertEqual(cancelled_ids, {"play-1", "play-2"})
            finally:
                player.close()

    def test_arquivo_inexistente_falha_sem_matar_worker(self) -> None:
        collector = EventCollector()
        player = PersistentWavePlayer(
            collector.emit,
            start_sound=lambda _path: 0.0,
            stop_sound=lambda: None,
        )
        try:
            player.enqueue("missing", Path("arquivo-que-nao-existe.wav"))
            collector.wait_for(lambda events: len(events) == 1)
            self.assertEqual(collector.events[0]["type"], "error")
            self.assertIn("não encontrado", str(collector.events[0]["error"]))
            self.assertTrue(player._worker.is_alive())
        finally:
            player.close()


if __name__ == "__main__":
    unittest.main()
