from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
import queue
import threading
import time
import wave

try:
    import winsound
except ImportError:  # pragma: no cover - exercised only outside Windows.
    winsound = None  # type: ignore[assignment]


PlaybackEvent = dict[str, object]
EventCallback = Callable[[PlaybackEvent], None]
StartSound = Callable[[Path], float]
StopSound = Callable[[], None]


@dataclass(frozen=True)
class _PlaybackRequest:
    request_id: str
    audio_path: Path
    cancelled: threading.Event


def system_playback_available() -> bool:
    return winsound is not None


def _wav_duration(audio_path: Path) -> float:
    with wave.open(str(audio_path), "rb") as wav_file:
        frame_rate = wav_file.getframerate()
        if frame_rate <= 0:
            raise ValueError("O WAV possui sample rate inválido.")
        return wav_file.getnframes() / frame_rate


def _start_system_sound(audio_path: Path) -> float:
    if winsound is None:
        raise RuntimeError("Playback persistente não está disponível nesta plataforma.")

    duration = _wav_duration(audio_path)
    winsound.PlaySound(
        str(audio_path),
        winsound.SND_FILENAME | winsound.SND_ASYNC,
    )
    return duration


def _stop_system_sound() -> None:
    if winsound is not None:
        # PlaySound(None, 0) cancela o som assíncrono pertencente a este
        # processo sem criar um novo PowerShell/SoundPlayer.
        winsound.PlaySound(None, 0)


class PersistentWavePlayer:
    """Single-worker WAV queue with cancellation and observable lifecycle."""

    def __init__(
        self,
        emit: EventCallback,
        *,
        start_sound: StartSound | None = None,
        stop_sound: StopSound | None = None,
        poll_interval: float = 0.01,
    ) -> None:
        if poll_interval <= 0:
            raise ValueError("poll_interval deve ser positivo.")

        self._emit = emit
        self._start_sound = start_sound or _start_system_sound
        self._stop_sound = stop_sound or _stop_system_sound
        self._poll_interval = poll_interval
        self._queue: queue.Queue[_PlaybackRequest | None] = queue.Queue()
        self._lock = threading.Lock()
        self._requests: dict[str, _PlaybackRequest] = {}
        self._active_request_id: str | None = None
        self._closed = False
        self._worker = threading.Thread(
            target=self._run,
            name="ultron-wave-player",
            daemon=True,
        )
        self._worker.start()

    def enqueue(self, request_id: str, audio_path: Path) -> None:
        request_id = request_id.strip()
        if not request_id:
            raise ValueError("id de playback é obrigatório.")

        request = _PlaybackRequest(
            request_id=request_id,
            audio_path=audio_path,
            cancelled=threading.Event(),
        )
        with self._lock:
            if self._closed:
                raise RuntimeError("O player persistente já foi encerrado.")
            if request_id in self._requests:
                raise ValueError(f"Playback duplicado: {request_id}")
            self._requests[request_id] = request

        self._queue.put(request)

    def cancel(self, request_id: str) -> bool:
        with self._lock:
            request = self._requests.get(request_id)
            if request is None:
                return False
            request.cancelled.set()
            if self._active_request_id == request_id:
                self._safe_stop_locked()
            return True

    def flush(self) -> int:
        with self._lock:
            requests = list(self._requests.values())
            for request in requests:
                request.cancelled.set()
            if self._active_request_id is not None:
                self._safe_stop_locked()
            return len(requests)

    def close(self, timeout: float = 1.0) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            for request in self._requests.values():
                request.cancelled.set()
            if self._active_request_id is not None:
                self._safe_stop_locked()
        self._queue.put(None)
        self._worker.join(timeout=max(0.0, timeout))

    def _safe_stop_locked(self) -> None:
        try:
            self._stop_sound()
        except Exception:
            # O worker ainda emitirá cancelled/error e limpará o request.
            pass

    def _run(self) -> None:
        while True:
            request = self._queue.get()
            if request is None:
                return
            self._play(request)

    def _play(self, request: _PlaybackRequest) -> None:
        if request.cancelled.is_set():
            self._finish(request, "playback_cancelled")
            return

        if not request.audio_path.is_file():
            self._finish(
                request,
                "error",
                error=f"Arquivo de áudio não encontrado: {request.audio_path}",
            )
            return

        try:
            # Hold the lock across the asynchronous start. A concurrent cancel
            # either wins before this block or stops a sound already started.
            with self._lock:
                self._active_request_id = request.request_id
                if request.cancelled.is_set():
                    duration = 0.0
                else:
                    duration = max(0.0, float(self._start_sound(request.audio_path)))

            if request.cancelled.is_set():
                self._finish(request, "playback_cancelled")
                return

            self._emit({
                "id": request.request_id,
                "type": "playback_started",
                "path": str(request.audio_path.resolve()),
            })

            deadline = time.monotonic() + duration
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if request.cancelled.wait(min(self._poll_interval, remaining)):
                    break

            if request.cancelled.is_set():
                with self._lock:
                    self._safe_stop_locked()
                self._finish(request, "playback_cancelled")
            else:
                self._finish(request, "playback_finished")
        except Exception as error:
            self._finish(request, "error", error=str(error))

    def _finish(
        self,
        request: _PlaybackRequest,
        event_type: str,
        *,
        error: str | None = None,
    ) -> None:
        with self._lock:
            if self._active_request_id == request.request_id:
                self._active_request_id = None
            self._requests.pop(request.request_id, None)

        event: PlaybackEvent = {
            "id": request.request_id,
            "type": event_type,
        }
        if error:
            event["error"] = error
        self._emit(event)


def create_system_player(emit: EventCallback) -> PersistentWavePlayer | None:
    if not system_playback_available():
        return None
    return PersistentWavePlayer(emit)
