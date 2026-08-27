from __future__ import annotations

import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np


SOURCE_ROOT = Path(__file__).resolve().parents[1] / "src"
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))

import capture_service  # noqa: E402


class CaptureObserveOnlyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.blocks = [np.ones(2400, dtype=np.float32) * 0.05]
        self.endpoint = {
            "reason": "silence",
            "speechDurationMs": 500,
            "voicedDurationMs": 200,
            "endpointDelayMs": 300,
            "silenceTargetMs": 300,
            "detector": "webrtcvad",
        }

    def test_observe_only_never_concatenates_or_saves_microphone_audio(self) -> None:
        with (
            patch.object(capture_service.np, "concatenate") as concatenate,
            patch.object(capture_service, "save_wav") as save_wav,
        ):
            message = capture_service.build_audio_message(
                self.blocks,
                self.endpoint,
                observe_only=True,
            )

        self.assertIsNone(message)
        concatenate.assert_not_called()
        save_wav.assert_not_called()

    def test_default_contract_still_emits_the_existing_audio_message(self) -> None:
        expected_path = Path("C:/Temp/speech.wav")
        with patch.object(
            capture_service,
            "save_wav",
            return_value=expected_path,
        ) as save_wav:
            message = capture_service.build_audio_message(
                self.blocks,
                self.endpoint,
                observe_only=False,
            )

        save_wav.assert_called_once()
        self.assertEqual(message, {
            "type": "audio",
            "path": str(expected_path),
            "endpoint": self.endpoint,
        })

    def test_speech_start_telemetry_is_numeric_and_content_free(self) -> None:
        message = capture_service.build_speech_start_message(
            rms=0.07123456,
            playback=True,
            detector="webrtcvad",
            detection_latency_ms=87.1236,
            queue_age_ms=2.5678,
        )
        self.assertEqual(set(message), {
            "type",
            "rms",
            "playback",
            "detector",
            "detectionLatencyMs",
            "queueAgeMs",
        })
        self.assertEqual(message["detectionLatencyMs"], 87.124)
        self.assertEqual(message["queueAgeMs"], 2.568)
        self.assertNotIn("path", message)
        self.assertNotIn("text", message)

    def test_observe_only_main_loop_handles_two_utterances_without_wav_or_pause(self) -> None:
        messages: list[dict] = []
        speech_flags = ([True] * 5 + [False] * 10) * 2
        blocks = iter(speech_flags)
        detector = Mock(name="detector")
        detector.name = "webrtcvad"
        detector.is_speech.side_effect = speech_flags
        capture_queue = Mock()

        def next_block(*, timeout: float):
            try:
                is_speech = next(blocks)
            except StopIteration:
                capture_service.running = False
                raise capture_service.queue.Empty
            samples = np.full(2400, 0.05 if is_speech else 0.0, dtype=np.float32)
            return samples, capture_service.time.monotonic() * 1000 - 50

        capture_queue.get.side_effect = next_block
        with (
            patch.object(capture_service, "running", True),
            patch.object(capture_service, "paused", False),
            patch.object(capture_service, "CAPTURE_OBSERVE_ONLY", True),
            patch.object(capture_service, "open_input_stream", return_value=nullcontext()),
            patch.object(capture_service, "SpeechDetector", return_value=detector),
            patch.object(capture_service.threading, "Thread"),
            patch.object(capture_service, "audio_queue", capture_queue),
            patch.object(capture_service, "control_queue", capture_service.queue.Queue()),
            patch.object(capture_service, "send_message", side_effect=messages.append),
            patch.object(capture_service.np, "concatenate") as concatenate,
            patch.object(capture_service, "save_wav") as save_wav,
        ):
            capture_service.main()
            self.assertFalse(capture_service.paused)

        self.assertTrue(messages[0]["observeOnly"])
        self.assertEqual(sum(message["type"] == "speech_start" for message in messages), 2)
        self.assertEqual(sum(message["type"] == "speech_end" for message in messages), 2)
        self.assertFalse(any(message["type"] == "audio" for message in messages))
        concatenate.assert_not_called()
        save_wav.assert_not_called()


if __name__ == "__main__":
    unittest.main()
