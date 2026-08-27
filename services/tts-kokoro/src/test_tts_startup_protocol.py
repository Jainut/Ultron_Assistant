from io import StringIO
from pathlib import Path
from types import ModuleType
from unittest.mock import patch
import importlib.util
import sys
import unittest


class TtsStartupProtocolTests(unittest.TestCase):
    def test_ready_preserva_capabilities_e_publica_metricas_apos_warm_up(self) -> None:
        events: list[str] = []
        messages: list[dict] = []

        player_module = ModuleType("persistent_player")

        class FakePlayer:
            def close(self) -> None:
                events.append("closed")

        player_module.PersistentWavePlayer = FakePlayer

        def create_system_player(_emit):
            events.append("player")
            return FakePlayer()

        player_module.create_system_player = create_system_player

        voice_module = ModuleType("voice_engine")
        voice_module.generate_audio = lambda **_kwargs: None

        def warm_up() -> None:
            events.append("warm_up")

        voice_module.warm_up = warm_up
        voice_module.get_startup_metrics = lambda: {
            "pipelineInitializationMs": 6200.0,
            "kokoroWarmUpMs": 1700.0,
            "effectsWarmUpMs": 5700.0,
            "warmUpTotalMs": 7400.0,
        }

        module_name = "ultron_tts_service_protocol_test_target"
        service_path = Path(__file__).with_name("tts_service.py")
        spec = importlib.util.spec_from_file_location(module_name, service_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader if spec else None)

        with patch.dict(sys.modules, {
            "persistent_player": player_module,
            "voice_engine": voice_module,
        }):
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(module)

        module.send_message = lambda message: (
            events.append(str(message.get("type"))),
            messages.append(message),
        )

        with patch.object(sys, "stdin", StringIO("")):
            module.main()

        ready = messages[0]
        self.assertEqual(events[:3], ["warm_up", "player", "ready"])
        self.assertEqual(
            ready["capabilities"],
            ["synthesis-v1", "playback-v1"],
        )
        self.assertEqual(ready["startup"]["pipelineInitializationMs"], 6200.0)
        self.assertEqual(ready["startup"]["warmUpTotalMs"], 7400.0)
        self.assertGreaterEqual(ready["startup"]["serviceReadyMs"], 0.0)
        self.assertGreaterEqual(ready["startup"]["voiceDependenciesMs"], 0.0)


if __name__ == "__main__":
    unittest.main()
