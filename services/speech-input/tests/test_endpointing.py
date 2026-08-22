from __future__ import annotations

import sys
import unittest
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SOURCE_ROOT))

from endpointing import AdaptiveEndpoint, EndpointingConfig  # noqa: E402


class AdaptiveEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.endpoint = AdaptiveEndpoint(EndpointingConfig())

    def test_short_command_finishes_after_300ms_not_750ms(self) -> None:
        for _ in range(8):
            self.endpoint.observe(True)

        decisions = [self.endpoint.observe(False) for _ in range(6)]

        self.assertFalse(decisions[-2].finished)
        self.assertTrue(decisions[-1].finished)
        self.assertAlmostEqual(
            decisions[-1].trailing_silence_seconds,
            0.30,
        )
        self.assertLessEqual(decisions[-1].trailing_silence_seconds, 0.40)

    def test_internal_pause_extends_next_endpoint_without_exceeding_400ms(self) -> None:
        for _ in range(40):
            self.endpoint.observe(True)
        self.endpoint.observe(False)
        self.endpoint.observe(False)
        resumed = self.endpoint.observe(True)
        self.assertEqual(resumed.pause_count, 1)

        decisions = [self.endpoint.observe(False) for _ in range(8)]

        self.assertFalse(decisions[-2].finished)
        self.assertTrue(decisions[-1].finished)
        self.assertAlmostEqual(decisions[-1].required_silence_seconds, 0.37)
        self.assertAlmostEqual(decisions[-1].trailing_silence_seconds, 0.40)

    def test_continuous_voice_never_finishes(self) -> None:
        decisions = [self.endpoint.observe(True) for _ in range(500)]
        self.assertFalse(any(decision.finished for decision in decisions))
        self.assertAlmostEqual(decisions[-1].required_silence_seconds, 0.35)

    def test_invalid_silence_order_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            EndpointingConfig(
                minimum_silence_seconds=0.40,
                target_silence_seconds=0.32,
                maximum_silence_seconds=0.28,
            )


if __name__ == "__main__":
    unittest.main()
