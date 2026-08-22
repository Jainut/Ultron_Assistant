from __future__ import annotations

import unittest

from echo_reference_scenarios import run_benchmark


class PlaybackEchoReferenceBenchmarkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.report = run_benchmark(quick=True)

    def test_pure_echo_is_suppressed_with_delay_gain_and_noise(self) -> None:
        for scenario in self.report.pure_echo:
            with self.subTest(scenario=scenario.name):
                self.assertGreaterEqual(scenario.suppression_rate, 0.95)
                self.assertIsNotNone(scenario.median_delay_error_ms)
                self.assertLessEqual(scenario.median_delay_error_ms or 0.0, 5.0)

    def test_overlapping_or_unrelated_speech_is_not_suppressed(self) -> None:
        for scenario in self.report.overlapping_speech:
            with self.subTest(scenario=scenario.name):
                self.assertLessEqual(scenario.suppression_rate, 0.05)
        self.assertLessEqual(self.report.unrelated_speech.suppression_rate, 0.01)

    def test_generation_and_invalid_path_fail_safely(self) -> None:
        self.assertTrue(self.report.stale_generation_preserved)
        self.assertTrue(self.report.invalid_reference_fails_open)

    def test_processing_stays_below_ten_percent_of_a_50ms_block(self) -> None:
        self.assertLess(self.report.processing_p95_ms, 5.0)


if __name__ == "__main__":
    unittest.main()
