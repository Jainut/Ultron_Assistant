from __future__ import annotations

import math
import time
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


@dataclass(frozen=True)
class EchoReferenceConfig:
    sample_rate: int = 48000
    minimum_delay_ms: float = 0.0
    maximum_delay_ms: float = 250.0
    delay_step_ms: float = 5.0
    correlation_threshold: float = 0.97
    residual_ratio_threshold: float = 0.18
    minimum_reference_rms: float = 0.002
    maximum_wav_bytes: int = 64 * 1024 * 1024
    maximum_reference_seconds: float = 120.0
    expiry_grace_ms: float = 1500.0
    maximum_start_age_ms: float = 500.0

    def __post_init__(self) -> None:
        numeric_values = (
            self.minimum_delay_ms,
            self.maximum_delay_ms,
            self.delay_step_ms,
            self.correlation_threshold,
            self.residual_ratio_threshold,
            self.minimum_reference_rms,
            self.maximum_reference_seconds,
            self.expiry_grace_ms,
            self.maximum_start_age_ms,
        )
        if not all(math.isfinite(float(value)) for value in numeric_values):
            raise ValueError("echo reference config values must be finite")
        if self.sample_rate <= 0:
            raise ValueError("sample_rate must be positive")
        if self.minimum_delay_ms < 0:
            raise ValueError("minimum_delay_ms cannot be negative")
        if self.maximum_delay_ms < self.minimum_delay_ms:
            raise ValueError(
                "maximum_delay_ms must be at least minimum_delay_ms"
            )
        if self.delay_step_ms <= 0:
            raise ValueError("delay_step_ms must be positive")
        if not 0 < self.correlation_threshold <= 1:
            raise ValueError("correlation_threshold must be in (0, 1]")
        if not 0 <= self.residual_ratio_threshold <= 1:
            raise ValueError("residual_ratio_threshold must be in [0, 1]")
        if self.minimum_reference_rms < 0:
            raise ValueError("minimum_reference_rms cannot be negative")
        if self.maximum_wav_bytes <= 0:
            raise ValueError("maximum_wav_bytes must be positive")
        if self.maximum_reference_seconds <= 0:
            raise ValueError("maximum_reference_seconds must be positive")
        if self.expiry_grace_ms < 0:
            raise ValueError("expiry_grace_ms cannot be negative")
        if self.maximum_start_age_ms < 0:
            raise ValueError("maximum_start_age_ms cannot be negative")


@dataclass(frozen=True)
class EchoDecision:
    suppressed: bool
    correlation: float
    delay_ms: float
    residual_ratio: float
    generation: int
    reason: str
    processing_ms: float


@dataclass(frozen=True)
class _ActiveReference:
    audio: np.ndarray
    generation: int
    started_at_monotonic_ms: float
    duration_ms: float


def _decode_pcm(raw: bytes, sample_width: int) -> np.ndarray:
    if sample_width == 1:
        return (
            np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0
        ) / 128.0

    if sample_width == 2:
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0

    if sample_width == 3:
        packed = np.frombuffer(raw, dtype=np.uint8)
        if len(packed) % 3:
            raise ValueError("invalid 24-bit PCM byte count")
        packed = packed.reshape(-1, 3).astype(np.int32)
        values = packed[:, 0] | (packed[:, 1] << 8) | (packed[:, 2] << 16)
        values = np.where(values & 0x800000, values - 0x1000000, values)
        return values.astype(np.float32) / 8388608.0

    if sample_width == 4:
        return (
            np.frombuffer(raw, dtype="<i4").astype(np.float32)
            / 2147483648.0
        )

    raise ValueError(f"unsupported PCM sample width: {sample_width}")


def resample_linear(
    audio: np.ndarray,
    source_rate: int,
    target_rate: int,
) -> np.ndarray:
    if source_rate <= 0 or target_rate <= 0:
        raise ValueError("sample rates must be positive")

    mono = np.asarray(audio, dtype=np.float32).reshape(-1)
    if len(mono) == 0:
        raise ValueError("audio cannot be empty")
    if source_rate == target_rate:
        return np.ascontiguousarray(mono, dtype=np.float32)

    target_length = max(1, round(len(mono) * target_rate / source_rate))
    source_positions = np.arange(len(mono), dtype=np.float64)
    target_positions = np.arange(target_length, dtype=np.float64) * (
        source_rate / target_rate
    )
    target_positions = np.minimum(target_positions, len(mono) - 1)
    result = np.interp(target_positions, source_positions, mono)
    return np.ascontiguousarray(result, dtype=np.float32)


def load_wav_pcm(
    path: str | Path,
    target_rate: int,
    maximum_wav_bytes: int = 64 * 1024 * 1024,
    maximum_reference_seconds: float = 120.0,
) -> np.ndarray:
    if target_rate <= 0:
        raise ValueError("target rate must be positive")
    if maximum_wav_bytes <= 0 or maximum_reference_seconds <= 0:
        raise ValueError("WAV limits must be positive")
    wav_path = Path(path)
    if not wav_path.is_absolute() or wav_path.suffix.lower() != ".wav":
        raise ValueError("WAV reference must be an absolute .wav path")
    stat = wav_path.stat()
    if not wav_path.is_file():
        raise ValueError("WAV path is not a file")
    if stat.st_size <= 0 or stat.st_size > maximum_wav_bytes:
        raise ValueError("WAV file size is outside the allowed range")

    with wave.open(str(wav_path), "rb") as wav_file:
        if wav_file.getcomptype() != "NONE":
            raise ValueError("compressed WAV is not supported")

        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        source_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()

        if channels <= 0 or channels > 32:
            raise ValueError("invalid WAV channel count")
        if sample_width not in {1, 2, 3, 4}:
            raise ValueError("unsupported WAV sample width")
        if source_rate <= 0 or frame_count <= 0:
            raise ValueError("invalid WAV rate or frame count")
        if frame_count / source_rate > maximum_reference_seconds:
            raise ValueError("WAV reference exceeds maximum duration")

        expected_bytes = frame_count * channels * sample_width
        if expected_bytes > maximum_wav_bytes:
            raise ValueError("WAV PCM payload exceeds maximum size")

        raw = wav_file.readframes(frame_count)

    if len(raw) != expected_bytes:
        raise ValueError("truncated WAV data")

    decoded = _decode_pcm(raw, sample_width)
    if len(decoded) != frame_count * channels:
        raise ValueError("invalid WAV sample count")

    mono = decoded.reshape(frame_count, channels).mean(axis=1, dtype=np.float32)
    if not np.all(np.isfinite(mono)):
        raise ValueError("WAV contains non-finite samples")

    return resample_linear(mono, source_rate, target_rate)


class PlaybackEchoReference:
    """Conservative playback-reference correlator for pre-barge filtering.

    Failure to load, align, or evaluate a reference always produces an allow
    decision. The caller must never use this component as a general VAD gate.
    """

    def __init__(self, config: EchoReferenceConfig) -> None:
        self.config = config
        self._active: _ActiveReference | None = None

    @property
    def generation(self) -> int | None:
        return self._active.generation if self._active is not None else None

    def start(
        self,
        path: str | Path,
        generation: int,
        started_at_unix_ms: float,
        *,
        received_at_unix_ms: float | None = None,
        received_at_monotonic_ms: float | None = None,
    ) -> bool:
        def reject() -> bool:
            # A start message supersedes the previous playback. If its
            # reference cannot be trusted, fail open rather than correlate the
            # new playback against stale audio.
            self._active = None
            return False

        if (
            not isinstance(path, (str, Path))
            or isinstance(generation, bool)
            or not isinstance(generation, int)
            or generation < 0
            or isinstance(started_at_unix_ms, bool)
            or not isinstance(started_at_unix_ms, (int, float))
        ):
            return reject()
        if not math.isfinite(started_at_unix_ms) or started_at_unix_ms <= 0:
            return reject()

        try:
            audio = load_wav_pcm(
                path,
                target_rate=self.config.sample_rate,
                maximum_wav_bytes=self.config.maximum_wav_bytes,
                maximum_reference_seconds=self.config.maximum_reference_seconds,
            )
        except (OSError, EOFError, ValueError, wave.Error):
            return reject()

        received_wall = (
            time.time() * 1000.0
            if received_at_unix_ms is None
            else received_at_unix_ms
        )
        received_monotonic = (
            time.monotonic() * 1000.0
            if received_at_monotonic_ms is None
            else received_at_monotonic_ms
        )
        if (
            isinstance(received_wall, bool)
            or not isinstance(received_wall, (int, float))
            or isinstance(received_monotonic, bool)
            or not isinstance(received_monotonic, (int, float))
            or not math.isfinite(received_wall)
            or not math.isfinite(received_monotonic)
        ):
            return reject()

        # Translate the external wall-clock timestamp once, at the protocol
        # boundary. Alignment and expiry after this point use only the local
        # monotonic clock, so a system-clock correction cannot suppress speech.
        reported_age_ms = received_wall - started_at_unix_ms
        clamped_age_ms = min(
            self.config.maximum_start_age_ms,
            max(0.0, reported_age_ms),
        )

        # Publish the fully validated object atomically.
        self._active = _ActiveReference(
            audio=audio,
            generation=generation,
            started_at_monotonic_ms=received_monotonic - clamped_age_ms,
            duration_ms=len(audio) * 1000.0 / self.config.sample_rate,
        )
        return True

    def end(self, generation: int) -> bool:
        if self._active is None or self._active.generation != generation:
            return False
        self._active = None
        return True

    def clear(self) -> None:
        """Fail-open cleanup for the legacy playback-active boundary."""

        self._active = None

    def evaluate(
        self,
        block: np.ndarray,
        block_started_at_monotonic_ms: float | None = None,
        now_monotonic_ms: float | None = None,
    ) -> EchoDecision:
        processing_started = time.perf_counter()
        active = self._active

        def allow(reason: str, generation: int = -1) -> EchoDecision:
            return EchoDecision(
                suppressed=False,
                correlation=0.0,
                delay_ms=0.0,
                residual_ratio=1.0,
                generation=generation,
                reason=reason,
                processing_ms=max(
                    0.0,
                    (time.perf_counter() - processing_started) * 1000.0,
                ),
            )

        if active is None:
            return allow("no_reference")

        current_monotonic_ms = (
            time.monotonic() * 1000.0
            if now_monotonic_ms is None
            else now_monotonic_ms
        )
        if (
            isinstance(current_monotonic_ms, bool)
            or not isinstance(current_monotonic_ms, (int, float))
            or not math.isfinite(current_monotonic_ms)
        ):
            return allow("invalid_time", active.generation)

        expires_at = (
            active.started_at_monotonic_ms
            + active.duration_ms
            + self.config.maximum_delay_ms
            + self.config.expiry_grace_ms
        )
        if current_monotonic_ms > expires_at:
            # Expiry is generation-local because `active` is the exact object
            # observed above. Capture is single-threaded today, but this keeps
            # the invariant explicit if controls move to another thread later.
            if self._active is active:
                self._active = None
            return allow("expired", active.generation)

        try:
            samples = np.asarray(block, dtype=np.float32).reshape(-1)
        except (TypeError, ValueError):
            return allow("invalid_block", active.generation)
        if len(samples) == 0 or not np.all(np.isfinite(samples)):
            return allow("invalid_block", active.generation)
        samples = np.clip(samples, -1.0, 1.0)

        block_start = (
            current_monotonic_ms
            - len(samples) * 1000.0 / self.config.sample_rate
            if block_started_at_monotonic_ms is None
            else block_started_at_monotonic_ms
        )
        if (
            isinstance(block_start, bool)
            or not isinstance(block_start, (int, float))
            or not math.isfinite(block_start)
        ):
            return allow("invalid_time", active.generation)

        microphone = samples.astype(np.float64, copy=False)
        microphone = microphone - float(np.mean(microphone))
        microphone_energy = float(np.dot(microphone, microphone))
        if microphone_energy <= np.finfo(np.float64).eps:
            return allow("silent_block", active.generation)

        best_correlation = -1.0
        best_delay_ms = 0.0
        best_residual_ratio = 1.0

        delay_count = int(
            math.floor(
                (
                    self.config.maximum_delay_ms
                    - self.config.minimum_delay_ms
                )
                / self.config.delay_step_ms
            )
        ) + 1

        for delay_index in range(delay_count):
            delay_ms = (
                self.config.minimum_delay_ms
                + delay_index * self.config.delay_step_ms
            )
            reference_offset_ms = (
                block_start - active.started_at_monotonic_ms - delay_ms
            )
            reference_start = round(
                reference_offset_ms * self.config.sample_rate / 1000.0
            )
            reference_end = reference_start + len(samples)
            if reference_start < 0 or reference_end > len(active.audio):
                continue

            reference = active.audio[reference_start:reference_end].astype(
                np.float64,
                copy=False,
            )
            reference = reference - float(np.mean(reference))
            reference_energy = float(np.dot(reference, reference))
            if reference_energy <= np.finfo(np.float64).eps:
                continue

            reference_rms = math.sqrt(reference_energy / len(reference))
            if reference_rms < self.config.minimum_reference_rms:
                continue

            dot_product = float(np.dot(microphone, reference))
            if abs(dot_product) <= np.finfo(np.float64).eps:
                continue

            # Alguns caminhos de alto-falante/microfone invertem a polaridade.
            # O residual com ganho assinado continua sendo a defesa decisiva.
            correlation = abs(dot_product) / math.sqrt(
                microphone_energy * reference_energy
            )
            correlation = min(1.0, max(0.0, correlation))

            if correlation <= best_correlation:
                continue

            gain = dot_product / reference_energy
            residual = microphone - gain * reference
            residual_energy = max(0.0, float(np.dot(residual, residual)))
            residual_ratio = math.sqrt(residual_energy / microphone_energy)

            best_correlation = correlation
            best_delay_ms = delay_ms
            best_residual_ratio = min(1.0, max(0.0, residual_ratio))

        if best_correlation < 0:
            return allow("unaligned", active.generation)

        suppressed = (
            best_correlation >= self.config.correlation_threshold
            and best_residual_ratio <= self.config.residual_ratio_threshold
        )
        return EchoDecision(
            suppressed=suppressed,
            correlation=float(best_correlation),
            delay_ms=float(best_delay_ms),
            residual_ratio=float(best_residual_ratio),
            generation=active.generation,
            reason="echo" if suppressed else "different_speech",
            processing_ms=max(
                0.0,
                (time.perf_counter() - processing_started) * 1000.0,
            ),
        )
