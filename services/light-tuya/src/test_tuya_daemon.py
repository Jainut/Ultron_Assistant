import contextlib
import io
import json
import unittest
from unittest.mock import patch

import home_service as home
import light_service as light
import tuya_daemon as daemon


class FakeBulb:
    bulb_configured = True

    def __init__(self):
        self.detects = 0
        self.reads = 0
        self.commands = []
        self.closed = False
        self.observed = {"is_on": False, "mode": "white", "brightness": 200, "colourtemp": 500}

    def set_socketPersistent(self, value): self.persistent = value
    def set_socketTimeout(self, value): self.timeout = value
    def set_socketRetryLimit(self, value): self.retries = value
    def set_socketRetryDelay(self, value): pass
    def detect_bulb(self): self.detects += 1
    def close(self): self.closed = True
    def cache_clear(self): pass
    def turn_on(self): self.commands.append("on"); return {}
    def turn_off(self): self.commands.append("off"); return {}
    def set_brightness_percentage(self, value): self.commands.append(value); return {}
    def set_white_percentage(self, **values): self.commands.append(values); return {}
    def set_colour(self, *values): self.commands.append(values); return {}
    def get_brightness_percentage(self, state): return state.get("brightness")
    def get_colourtemp_percentage(self, state): return state.get("colourtemp")
    def get_mode(self, state): return state.get("mode")
    def colour_rgb(self, state): return (0, 0, 0)

    def state(self):
        self.reads += 1
        return self.observed.copy()


class FakeCloud:
    def __init__(self):
        self.functions = 0
        self.commands = []
        self.status = {"success": True, "result": [{"code": "switch_1", "value": True}]}

    def getfunctions(self, device):
        self.functions += 1
        return {"success": True, "result": {"functions": [{"code": "switch_1", "type": "Boolean"}]}}

    def getstatus(self, device): return self.status
    def sendcommand(self, device, payload): self.commands.append(payload); return {"success": True}


class TuyaDaemonTests(unittest.TestCase):
    def setUp(self):
        home._switch_codes.clear()
        light._cloud_state.clear()

    def test_two_actions_reuse_connection_detection_and_no_readback_on_fast_path(self):
        bulb = FakeBulb()
        transport = daemon.PersistentLight()
        with patch.object(light, "get_bulb", return_value=bulb) as factory, patch.dict("os.environ", {"ULTRON_TUYA_FAST_CONFIRM": "1", "ULTRON_TUYA_SKIP_LOCAL": "0"}):
            first = transport.execute(["on"])
            second = transport.execute(["brightness", "20"])
        factory.assert_called_once_with(probe=False)
        self.assertEqual(bulb.detects, 1)
        self.assertEqual(bulb.reads, 0)
        self.assertTrue(bulb.persistent)
        self.assertFalse(first["confirmed"])
        self.assertTrue(second["optimistic"])
        transport.close()
        self.assertTrue(bulb.closed)

    def test_status_never_promotes_optimistic_cache_and_reads_device(self):
        bulb = FakeBulb()
        with patch.object(light, "get_bulb", return_value=bulb), patch.dict("os.environ", {"ULTRON_TUYA_FAST_CONFIRM": "1", "ULTRON_TUYA_SKIP_LOCAL": "0"}):
            transport = daemon.PersistentLight()
            transport.execute(["on"])
            status = transport.execute(["status"])
        self.assertTrue(status["confirmed"])
        self.assertFalse(status["state"]["is_on"])
        self.assertEqual(bulb.reads, 1)

    def test_wrong_or_missing_readback_does_not_confirm(self):
        bulb = FakeBulb()
        bulb.observed = {}
        with patch.object(light, "get_bulb", return_value=bulb), patch.dict("os.environ", {"ULTRON_TUYA_FAST_CONFIRM": "0", "ULTRON_TUYA_SKIP_LOCAL": "0"}):
            result = daemon.PersistentLight().execute(["off"])
        self.assertFalse(result["confirmed"])
        self.assertEqual(result["status"], "unknown")

    def test_failed_local_is_cooled_down_but_can_recover(self):
        clock = [0.0]
        transport = daemon.PersistentLight(clock=lambda: clock[0])
        with patch.object(light, "get_bulb", side_effect=ConnectionError("offline")) as factory, patch.object(light, "cloud_fallback", return_value={"success": True}) as cloud, patch.dict("os.environ", {"ULTRON_TUYA_SKIP_LOCAL": "0"}):
            transport.execute(["on"])
            transport.execute(["off"])
            self.assertEqual(factory.call_count, 1)
            self.assertEqual(cloud.call_count, 2)
            clock[0] = 61
            transport.execute(["on"])
            self.assertEqual(factory.call_count, 2)

    def test_invalid_light_arguments_never_reach_local_or_cloud(self):
        with patch.object(light, "get_bulb") as local, patch.object(light, "cloud_fallback") as cloud:
            for args in (["toggle"], ["brightness", "101"], ["white", "20"], ["color", "-1", "0", "0"]):
                with self.assertRaises(ValueError): daemon.PersistentLight().execute(args)
            local.assert_not_called()
            cloud.assert_not_called()

    def test_home_caches_switch_capability_and_reports_optimistic(self):
        cloud = FakeCloud()
        with patch.object(home, "get_cloud", return_value=cloud):
            first = home.execute(["control", "device", "on"])
            second = home.execute(["control", "device", "off"])
        self.assertEqual(cloud.functions, 1)
        self.assertEqual(len(cloud.commands), 2)
        self.assertFalse(first["confirmed"])
        self.assertTrue(second["optimistic"])

    def test_unknown_home_toggle_never_sends_command(self):
        cloud = FakeCloud()
        cloud.status = {"success": True, "result": []}
        with patch.object(home, "get_cloud", return_value=cloud):
            with self.assertRaisesRegex(RuntimeError, "Estado desconhecido"):
                home.execute(["control", "device", "toggle"])
        self.assertEqual(cloud.commands, [])

    def test_cloud_mismatched_brightness_is_not_confirmed(self):
        cloud = FakeCloud()
        cloud.status = {"success": True, "result": [{"code": "bright_value_v2", "value": 700}]}
        with patch.object(light, "get_cloud", return_value=(cloud, "device")), patch.object(light.time, "sleep"), patch.dict("os.environ", {"ULTRON_TUYA_FAST_CONFIRM": "0"}):
            result = light.cloud_fallback(["brightness", "20"])
        self.assertFalse(result["confirmed"])

    def test_protocol_keeps_request_ids_and_redacts_provider_failures(self):
        request = json.dumps({"id": "one", "arguments": ["on"]}) + "\n"
        output = io.StringIO()
        with patch.object(daemon.sys, "stdin", io.StringIO(request)), patch.object(daemon.PersistentLight, "execute", side_effect=RuntimeError("access_token=SECRET")), contextlib.redirect_stdout(output):
            daemon.run("light")
        self.assertNotIn("SECRET", output.getvalue())
        result = json.loads(output.getvalue().splitlines()[1])
        self.assertEqual(result["id"], "one")
        self.assertFalse(result["success"])


if __name__ == "__main__":
    unittest.main()
