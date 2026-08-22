from __future__ import annotations

import json
import math
import statistics
import sys
import tempfile
import wave
from dataclasses import asdict, dataclass
from itertools import product
from pathlib import Path
from typing import Iterable

import numpy as np


SOURCE_ROOT = Path(__file__).resolve().parents[1] / "src"
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

from playback_echo_reference import (  # noqa: E402
    EchoReferenceConfig,
    PlaybackEchoReference,
)


SAMPLE_RATE = 48_000
BLOCK_MS = 50
BLOCK_SAMPLES = SAMPLE_RATE * BLOCK_MS // 1_000
REFERENCE_SECONDS = 3.5
ANCHOR_UNIX_MS = 1_700_000_000_000.0
ANCHOR_MONOTONIC_MS = 10_000.0


@dataclass(frozen=True)
class ScenarioResult:
    name: str
    eligible_blocks: int
    suppressed_blocks: int
    suppression_rate: float
    median_correlation: float
    median_residual_ratio: float
    median_delay_error_ms: float | None
    processing_p50_ms: float
    processing_p95_ms: float


@dataclass(frozen=True)
class BenchmarkReport:
    pure_echo: tuple[ScenarioResult, ...]
    overlapping_speech: tuple[ScenarioResult, ...]
    unrelated_speech: ScenarioResult
    stale_generation_preserved: bool
    invalid_reference_fails_open: bool
    processing_p50_ms: float
    processing_p95_ms: float
    processing_max_ms: float

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, ensure_ascii=False)


def _voice_like_signal(seed: int, seconds: float = REFERENCE_SECONDS) -> np.ndarray:
    """Deterministic, broadband, speech-shaped fixture without external assets."""

    count = round(seconds * SAMPLE_RATE)
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(count).astype(np.float32)

    # A short FIR gives the signal voice-like temporal structure while keeping
    # enough bandwidth to make delay selection observable and reproducible.
    kernel = np.array(
        [0.52, 0.31, 0.16, 0.06, -0.04, -0.08, -0.05],
        dtype=np.float32,
    )
    shaped = np.convolve(noise, kernel, mode="same").astype(np.float32)
    time_axis = np.arange(count, dtype=np.float32) / SAMPLE_RATE
    voiced = (
        0.18 * np.sin(2 * np.pi * 137 * time_axis)
        + 0.10 * np.sin(2 * np.pi * 223 * time_axis + 0.7)
        + 0.05 * np.sin(2 * np.pi * 421 * time_axis + 1.3)
    )
    envelope = (
        0.68
        + 0.19 * np.sin(2 * np.pi * 2.7 * time_axis) ** 2
        + 0.13 * np.sin(2 * np.pi * 5.3 * time_axis + 0.4) ** 2
    )
    signal = (0.72 * shaped + voiced) * envelope
    rms = float(np.sqrt(np.mean(np.square(signal, dtype=np.float64))))
    return np.ascontiguousarray(signal * (0.18 / max(rms, 1e-9)), dtype=np.float32)


def _write_pcm16_wav(path: Path, audio: np.ndarray) -> None:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())


def _render_echo(
    reference: np.ndarray,
    *,
    delay_ms: float,
    gain: float,
    snr_db: float,
    seed: int,
    reflection_gain: float = 0.10,
) -> np.ndarray:
    delay_samples = round(delay_ms * SAMPLE_RATE / 1_000)
    reflection_samples = round(7.0 * SAMPLE_RATE / 1_000)
    output = np.zeros(len(reference) + delay_samples + reflection_samples, dtype=np.float32)
    output[delay_samples:delay_samples + len(reference)] += gain * reference
    output[
        delay_samples + reflection_samples:
        delay_samples + reflection_samples + len(reference)
    ] += gain * reflection_gain * reference

    active = output[delay_samples:delay_samples + len(reference)]
    active_rms = float(np.sqrt(np.mean(np.square(active, dtype=np.float64))))
    noise_rms = active_rms / (10 ** (snr_db / 20))
    noise = np.random.default_rng(seed).standard_normal(len(output)).astype(np.float32)
    output += noise * noise_rms
    return output


def _mix_near_speech(
    observed: np.ndarray,
    *,
    reference_rms: float,
    relative_gain: float,
    seed: int,
) -> np.ndarray:
    near = _voice_like_signal(seed, len(observed) / SAMPLE_RATE)
    near_rms = float(np.sqrt(np.mean(np.square(near, dtype=np.float64))))
    scaled = near * (reference_rms * relative_gain / max(near_rms, 1e-9))
    return np.ascontiguousarray(observed + scaled, dtype=np.float32)


def _percentile(values: Iterable[float], percentile: float) -> float:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * percentile / 100.0
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _evaluate_stream(
    reference_path: Path,
    observed: np.ndarray,
    *,
    name: str,
    expected_delay_ms: float | None,
    eligible_start_ms: float,
    eligible_end_ms: float,
    generation: int = 7,
) -> tuple[ScenarioResult, list[float]]:
    echo_reference = PlaybackEchoReference(EchoReferenceConfig(sample_rate=SAMPLE_RATE))
    started = echo_reference.start(
        reference_path,
        generation,
        ANCHOR_UNIX_MS,
        received_at_unix_ms=ANCHOR_UNIX_MS,
        received_at_monotonic_ms=ANCHOR_MONOTONIC_MS,
    )
    if not started:
        raise RuntimeError("synthetic playback reference was not accepted")

    decisions = []
    processing = []
    for block_start in range(0, len(observed) - BLOCK_SAMPLES + 1, BLOCK_SAMPLES):
        elapsed_ms = block_start * 1_000.0 / SAMPLE_RATE
        decision = echo_reference.evaluate(
            observed[block_start:block_start + BLOCK_SAMPLES],
            block_started_at_monotonic_ms=ANCHOR_MONOTONIC_MS + elapsed_ms,
            now_monotonic_ms=ANCHOR_MONOTONIC_MS + elapsed_ms + BLOCK_MS,
        )
        processing.append(decision.processing_ms)
        if eligible_start_ms <= elapsed_ms <= eligible_end_ms:
            decisions.append(decision)

    if not decisions:
        raise RuntimeError(f"scenario {name} produced no eligible blocks")

    delay_errors = (
        [abs(decision.delay_ms - expected_delay_ms) for decision in decisions]
        if expected_delay_ms is not None
        else []
    )
    result = ScenarioResult(
        name=name,
        eligible_blocks=len(decisions),
        suppressed_blocks=sum(decision.suppressed for decision in decisions),
        suppression_rate=sum(decision.suppressed for decision in decisions) / len(decisions),
        median_correlation=statistics.median(decision.correlation for decision in decisions),
        median_residual_ratio=statistics.median(
            decision.residual_ratio for decision in decisions
        ),
        median_delay_error_ms=(statistics.median(delay_errors) if delay_errors else None),
        processing_p50_ms=_percentile(processing, 50),
        processing_p95_ms=_percentile(processing, 95),
    )
    return result, processing


def run_benchmark(*, quick: bool = False) -> BenchmarkReport:
    reference = _voice_like_signal(41)
    reference_rms = float(np.sqrt(np.mean(np.square(reference, dtype=np.float64))))
    delays = (40.0, 160.0, 240.0) if quick else (20.0, 80.0, 160.0, 240.0)
    gains = (0.25, -0.85) if quick else (0.20, 0.55, 1.10, -0.55)
    pure_results: list[ScenarioResult] = []
    overlapping_results: list[ScenarioResult] = []
    all_processing: list[float] = []

    with tempfile.TemporaryDirectory(prefix="ultron-echo-benchmark-") as temp_directory:
        reference_path = Path(temp_directory) / "playback-reference.wav"
        _write_pcm16_wav(reference_path, reference)

        for scenario_index, (delay_ms, gain) in enumerate(product(delays, gains)):
            observed = _render_echo(
                reference,
                delay_ms=delay_ms,
                gain=gain,
                snr_db=24.0,
                seed=100 + scenario_index,
            )
            eligible_start = delay_ms + BLOCK_MS
            eligible_end = delay_ms + REFERENCE_SECONDS * 1_000 - 2 * BLOCK_MS
            result, processing = _evaluate_stream(
                reference_path,
                observed,
                name=f"echo delay={delay_ms:.0f}ms gain={gain:.2f}",
                expected_delay_ms=delay_ms,
                eligible_start_ms=eligible_start,
                eligible_end_ms=eligible_end,
            )
            pure_results.append(result)
            all_processing.extend(processing)

        overlap_delays = (80.0,) if quick else (40.0, 160.0, 240.0)
        overlap_ratios = (0.20, 0.35, 0.70)
        scenario_index = 0
        for delay_ms in overlap_delays:
            for relative_gain in overlap_ratios:
                echo = _render_echo(
                    reference,
                    delay_ms=delay_ms,
                    gain=0.75,
                    snr_db=30.0,
                    seed=300 + scenario_index,
                )
                mixed = _mix_near_speech(
                    echo,
                    reference_rms=reference_rms * 0.75,
                    relative_gain=relative_gain,
                    seed=700 + scenario_index,
                )
                result, processing = _evaluate_stream(
                    reference_path,
                    mixed,
                    name=(
                        f"overlap delay={delay_ms:.0f}ms "
                        f"near/echo={relative_gain:.2f}"
                    ),
                    expected_delay_ms=delay_ms,
                    eligible_start_ms=delay_ms + BLOCK_MS,
                    eligible_end_ms=(
                        delay_ms + REFERENCE_SECONDS * 1_000 - 2 * BLOCK_MS
                    ),
                )
                overlapping_results.append(result)
                all_processing.extend(processing)
                scenario_index += 1

        unrelated = _voice_like_signal(909)
        unrelated_result, processing = _evaluate_stream(
            reference_path,
            unrelated,
            name="unrelated near speech",
            expected_delay_ms=None,
            eligible_start_ms=BLOCK_MS,
            eligible_end_ms=REFERENCE_SECONDS * 1_000 - 2 * BLOCK_MS,
        )
        all_processing.extend(processing)

        generation_reference = PlaybackEchoReference(EchoReferenceConfig())
        started = generation_reference.start(
            reference_path,
            11,
            ANCHOR_UNIX_MS,
            received_at_unix_ms=ANCHOR_UNIX_MS,
            received_at_monotonic_ms=ANCHOR_MONOTONIC_MS,
        )
        stale_generation_preserved = (
            started
            and not generation_reference.end(10)
            and generation_reference.generation == 11
            and generation_reference.end(11)
            and generation_reference.generation is None
        )

        invalid_reference = PlaybackEchoReference(EchoReferenceConfig())
        invalid_reference_fails_open = (
            not invalid_reference.start(
                Path("relative-reference.wav"),
                12,
                ANCHOR_UNIX_MS,
                received_at_unix_ms=ANCHOR_UNIX_MS,
                received_at_monotonic_ms=ANCHOR_MONOTONIC_MS,
            )
            and not invalid_reference.evaluate(
                unrelated[:BLOCK_SAMPLES],
                block_started_at_monotonic_ms=ANCHOR_MONOTONIC_MS,
                now_monotonic_ms=ANCHOR_MONOTONIC_MS + BLOCK_MS,
            ).suppressed
        )

    return BenchmarkReport(
        pure_echo=tuple(pure_results),
        overlapping_speech=tuple(overlapping_results),
        unrelated_speech=unrelated_result,
        stale_generation_preserved=bool(stale_generation_preserved),
        invalid_reference_fails_open=bool(invalid_reference_fails_open),
        processing_p50_ms=_percentile(all_processing, 50),
        processing_p95_ms=_percentile(all_processing, 95),
        processing_max_ms=max(all_processing, default=0.0),
    )


if __name__ == "__main__":
    print(run_benchmark().to_json())
