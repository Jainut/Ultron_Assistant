from __future__ import annotations

import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np


SOURCE_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SOURCE_ROOT))

from playback_echo_reference import (  # noqa: E402
    EchoReferenceConfig,
    PlaybackEchoReference,
    load_wav_pcm,
)


def _encode_pcm(audio: np.ndarray, sample_width: int) -> bytes:
    clipped = np.clip(audio, -1.0, 1.0)
    if sample_width == 1:
        return np.round(clipped * 127.0 + 128.0).astype(np.uint8).tobytes()
    if sample_width == 2:
        return np.round(clipped * 32767.0).astype("<i2").tobytes()
    if sample_width == 3:
        values = np.round(clipped * 8388607.0).astype(np.int32)
        unsigned = values & 0xFFFFFF
        packed = np.column_stack((
            unsigned & 0xFF,
            (unsigned >> 8) & 0xFF,
            (unsigned >> 16) & 0xFF,
        )).astype(np.uint8)
        return packed.tobytes()
    if sample_width == 4:
        return np.round(clipped * 2147483647.0).astype("<i4").tobytes()
    raise ValueError("unsupported width")


def _write_wav(
    path: Path,
    audio: np.ndarray,
    sample_rate: int,
    sample_width: int = 2,
) -> None:
    frames = np.asarray(audio, dtype=np.float32)
    if frames.ndim == 1:
        frames = frames[:, np.newaxis]

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(frames.shape[1])
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(_encode_pcm(frames.reshape(-1), sample_width))


def _reference_audio(sample_rate: int, seconds: float = 3.0) -> np.ndarray:
    rng = np.random.default_rng(20260822)
    count = round(sample_rate * seconds)
    noise = rng.normal(0.0, 1.0, count + 12)
    shaped = np.convolve(noise, np.hanning(13), mode="valid")
    shaped /= np.max(np.abs(shaped))
    envelope = 0.45 + 0.35 * np.sin(
        np.arange(count) * 2 * np.pi * 2.3 / sample_rate
    )
    return (shaped[:count] * envelope * 0.55).astype(np.float32)


class PlaybackEchoReferenceTests(unittest.TestCase):
    sample_rate = 8000

    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.wav_path = Path(self.temporary_directory.name) / "reference.wav"
        self.reference = _reference_audio(self.sample_rate)
        _write_wav(self.wav_path, self.reference, self.sample_rate)
        self.config = EchoReferenceConfig(
            sample_rate=self.sample_rate,
            minimum_delay_ms=0,
            maximum_delay_ms=100,
            delay_step_ms=10,
            correlation_threshold=0.97,
            residual_ratio_threshold=0.18,
            minimum_reference_rms=0.002,
            expiry_grace_ms=100,
            maximum_start_age_ms=500,
        )

    def _started_correlator(self) -> PlaybackEchoReference:
        correlator = PlaybackEchoReference(self.config)
        loaded = correlator.start(
            self.wav_path,
            generation=7,
            started_at_unix_ms=10_000,
            received_at_unix_ms=10_100,
            received_at_monotonic_ms=5_000,
        )
        self.assertTrue(loaded)
        return correlator

    def test_aligned_echo_is_suppressed_and_reports_delay(self) -> None:
        correlator = self._started_correlator()
        block_samples = round(self.sample_rate * 0.05)
        reference_offset_ms = 800
        delay_ms = 80
        reference_start = round(reference_offset_ms * self.sample_rate / 1000)
        block = self.reference[reference_start:reference_start + block_samples]

        # Start anchored at monotonic 4900ms (100ms wall age at receipt).
        block_started = 4_900 + reference_offset_ms + delay_ms
        for gain in (0.37, -0.37):
            with self.subTest(gain=gain):
                decision = correlator.evaluate(
                    block * gain,
                    block_started_at_monotonic_ms=block_started,
                    now_monotonic_ms=block_started + 50,
                )

                self.assertTrue(decision.suppressed)
                self.assertGreater(decision.correlation, 0.999)
                self.assertLess(decision.residual_ratio, 0.01)
                self.assertEqual(decision.delay_ms, delay_ms)
                self.assertEqual(decision.generation, 7)
                self.assertGreaterEqual(decision.processing_ms, 0)

    def test_different_or_overlapping_speech_is_never_suppressed(self) -> None:
        correlator = self._started_correlator()
        block_samples = round(self.sample_rate * 0.05)
        reference_start = round(0.8 * self.sample_rate)
        echo = self.reference[reference_start:reference_start + block_samples]
        rng = np.random.default_rng(42)
        different_speech = rng.normal(0.0, 0.18, block_samples).astype(np.float32)
        block_started = 4_900 + 800 + 80

        different = correlator.evaluate(
            different_speech,
            block_started_at_monotonic_ms=block_started,
            now_monotonic_ms=block_started + 50,
        )
        self.assertFalse(different.suppressed)

        centered_near = different_speech - float(np.mean(different_speech))
        near_rms = float(np.sqrt(np.mean(centered_near**2)))
        echo_rms = float(np.sqrt(np.mean(echo**2)))
        for near_to_echo_ratio in (0.20, 0.35, 0.70):
            with self.subTest(near_to_echo_ratio=near_to_echo_ratio):
                scaled_near = centered_near * (
                    echo_rms * near_to_echo_ratio / near_rms
                )
                overlap = correlator.evaluate(
                    echo * 0.35 + scaled_near * 0.35,
                    block_started_at_monotonic_ms=block_started,
                    now_monotonic_ms=block_started + 50,
                )
                self.assertFalse(overlap.suppressed)
                self.assertGreater(
                    overlap.residual_ratio,
                    self.config.residual_ratio_threshold,
                )

    def test_end_only_clears_the_matching_generation(self) -> None:
        correlator = self._started_correlator()
        self.assertFalse(correlator.end(6))
        self.assertEqual(correlator.generation, 7)
        self.assertTrue(correlator.end(7))
        self.assertIsNone(correlator.generation)
        self.assertEqual(
            correlator.evaluate(np.ones(400, dtype=np.float32)).reason,
            "no_reference",
        )

        correlator = self._started_correlator()
        correlator.clear()
        self.assertIsNone(correlator.generation)

    def test_invalid_or_expired_reference_fails_open(self) -> None:
        correlator = self._started_correlator()
        self.assertFalse(correlator.start(
            self.wav_path.with_name("missing.wav"),
            generation=8,
            started_at_unix_ms=10_000,
            received_at_unix_ms=10_100,
            received_at_monotonic_ms=5_000,
        ))
        self.assertIsNone(correlator.generation)

        self.assertFalse(correlator.start(
            self.wav_path,
            generation=-1,
            started_at_unix_ms=10_000,
            received_at_unix_ms=10_100,
            received_at_monotonic_ms=5_000,
        ))
        self.assertIsNone(correlator.generation)
        self.assertEqual(
            correlator.evaluate(np.ones(400, dtype=np.float32)).reason,
            "no_reference",
        )

        correlator = self._started_correlator()
        decision = correlator.evaluate(
            np.ones(400, dtype=np.float32),
            now_monotonic_ms=9_000,
        )
        self.assertFalse(decision.suppressed)
        self.assertEqual(decision.reason, "expired")
        self.assertIsNone(correlator.generation)

    def test_loads_common_pcm_widths_mixes_to_mono_and_resamples(self) -> None:
        source_rate = 4000
        left = _reference_audio(source_rate, seconds=0.2)
        right = left * 0.5
        stereo = np.column_stack((left, right))

        for sample_width in (1, 2, 3, 4):
            with self.subTest(sample_width=sample_width):
                path = Path(self.temporary_directory.name) / (
                    f"pcm-{sample_width}.wav"
                )
                _write_wav(path, stereo, source_rate, sample_width)
                loaded = load_wav_pcm(path, target_rate=self.sample_rate)
                self.assertEqual(len(loaded), len(left) * 2)
                self.assertTrue(np.all(np.isfinite(loaded)))
                self.assertGreater(float(np.sqrt(np.mean(loaded**2))), 0.01)

    def test_wall_clock_timestamp_is_clamped_then_alignment_is_monotonic(self) -> None:
        correlator = PlaybackEchoReference(self.config)
        self.assertTrue(correlator.start(
            self.wav_path,
            generation=9,
            started_at_unix_ms=1_000,
            received_at_unix_ms=10_000,
            received_at_monotonic_ms=5_000,
        ))
        # Nine seconds of reported wall age is clamped to 500ms. The local
        # playback start is therefore monotonic 4500ms.
        offset_ms = 500
        block_samples = round(self.sample_rate * 0.05)
        start = round(offset_ms * self.sample_rate / 1000)
        decision = correlator.evaluate(
            self.reference[start:start + block_samples],
            block_started_at_monotonic_ms=4_500 + offset_ms,
            now_monotonic_ms=4_500 + offset_ms + 50,
        )
        self.assertTrue(decision.suppressed)


if __name__ == "__main__":
    unittest.main()
