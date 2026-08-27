"""Persistent local/cloud transport. The legacy CLI remains available unchanged.

Requests are serialized by the Node client: at most one is written to stdin.
Killing this worker cancels blocked I/O, never queues a later device mutation.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time

import light_service as light
import home_service as home


def validate_light(arguments: list[str]) -> str:
    if not arguments:
        raise ValueError("Informe uma ação para a lâmpada.")
    action = arguments[0].lower()
    counts = {"status": 0, "on": 0, "off": 0, "brightness": 1, "white": 2, "color": 3}
    if action not in counts or len(arguments) != counts[action] + 1:
        raise ValueError("Ação ou argumentos de lâmpada inválidos.")
    maximum = 255 if action == "color" else 100
    if any(not 0 <= int(value) <= maximum for value in arguments[1:]):
        raise ValueError("Valor de brilho, temperatura ou RGB fora do intervalo permitido.")
    return action


def close_enough(actual, desired: int) -> bool:
    return (isinstance(actual, (int, float)) and not isinstance(actual, bool)
            and math.isfinite(actual) and abs(actual - desired) <= 3)


class PersistentLight:
    def __init__(self, clock=time.monotonic):
        self.bulb = None
        self.state: dict = {}
        self.retry_local_at = 0.0
        self.clock = clock

    def close(self):
        if self.bulb is not None:
            self.bulb.close()
        self.bulb = None

    def get_bulb(self):
        if self.bulb is None:
            bulb = light.get_bulb(probe=False)
            try:
                bulb.set_socketPersistent(True)
                bulb.set_socketTimeout(1.0)
                bulb.set_socketRetryLimit(1)
                bulb.set_socketRetryDelay(0.05)
                bulb.detect_bulb()
                if not bulb.bulb_configured:
                    raise ConnectionError("A lâmpada não respondeu à identificação local.")
                self.bulb = bulb
            except Exception:
                bulb.close()
                raise
        return self.bulb

    def execute(self, arguments: list[str]) -> dict:
        action = validate_light(arguments)
        arguments = [action, *arguments[1:]]
        started = self.clock()
        if os.getenv("ULTRON_TUYA_SKIP_LOCAL") != "1" and started >= self.retry_local_at:
            try:
                result = self.execute_local(arguments)
                result["transport_ms"] = round((self.clock() - started) * 1000, 3)
                return result
            except Exception:
                # Only idempotent light operations reach this fallback. Never
                # retry toggles; a partially applied brightness/on/off is safe.
                self.close()
                self.state = {}
                self.retry_local_at = self.clock() + 60
        result = light.cloud_fallback(arguments)
        result["transport_ms"] = round((self.clock() - started) * 1000, 3)
        return result

    def execute_local(self, arguments: list[str]) -> dict:
        action = arguments[0]
        bulb = self.get_bulb()
        updates: dict = {}
        if action == "on" or action == "off":
            result = bulb.turn_on() if action == "on" else bulb.turn_off()
            updates["is_on"] = action == "on"
        elif action == "brightness":
            result = bulb.set_brightness_percentage(int(arguments[1]))
            updates["brightness_percentage"] = int(arguments[1])
        elif action == "white":
            result = bulb.set_white_percentage(brightness=int(arguments[1]), colourtemp=int(arguments[2]))
            updates.update(mode="white", brightness_percentage=int(arguments[1]), temperature_percentage=int(arguments[2]))
        elif action == "color":
            result = bulb.set_colour(*map(int, arguments[1:4]))
            updates.update(mode="colour", rgb=list(map(int, arguments[1:4])))
        else:
            result = None

        if action != "status":
            light.ensure_tuya_success(result, "Comando local")
            # A TinyTuya error is checked above. A normal ACK is accepted, not
            # physical proof; cached desired values never become readback.
            self.state.update(updates)
        readback = action == "status" or os.getenv("ULTRON_TUYA_FAST_CONFIRM", "0") != "1"
        confirmed = False
        if readback:
            bulb.cache_clear()
            self.state = light.read_state(bulb)
            if action in ("on", "off", "status"):
                power = self.state.get("is_on")
                confirmed = isinstance(power, bool) and (action == "status" or power == (action == "on"))
            elif action == "brightness":
                confirmed = close_enough(bulb.get_brightness_percentage(self.state), int(arguments[1]))
            elif action == "white":
                confirmed = (bulb.get_mode(self.state) == "white"
                             and close_enough(bulb.get_brightness_percentage(self.state), int(arguments[1]))
                             and close_enough(bulb.get_colourtemp_percentage(self.state), int(arguments[2])))
            elif action == "color":
                colour = bulb.colour_rgb(self.state)
                confirmed = (isinstance(colour, (list, tuple)) and len(colour) == 3
                             and all(close_enough(value, int(target)) for value, target in zip(colour, arguments[1:4])))
        return {
            "success": True, "action": action, "transport": "tuya_local",
            "confirmed": confirmed,
            "optimistic": action != "status" and not readback,
            "status": "confirmed" if confirmed else "optimistic" if not readback else "unknown",
            "state": dict(self.state),
            "message": "Estado real ainda não confirmado." if readback and not confirmed else None,
        }


def run(mode: str) -> None:
    transport = PersistentLight()
    light.send({"type": "ready", "mode": mode})
    try:
        for line in sys.stdin:
            request = None
            try:
                if len(line) > 16_384:
                    raise ValueError("Requisição Tuya excede o limite permitido.")
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("id"), str):
                    raise ValueError("Requisição Tuya inválida.")
                arguments = request.get("arguments")
                if not isinstance(arguments, list) or not all(isinstance(value, str) for value in arguments):
                    raise ValueError("Argumentos Tuya inválidos.")
                result = transport.execute(arguments) if mode == "light" else home.execute(arguments)
                light.send({**result, "id": request["id"], "type": "result"})
            except Exception as error:
                # Do not return provider payloads, signed URLs, keys or tokens.
                message = ("Ação ou argumentos Tuya inválidos." if isinstance(error, (ValueError, IndexError))
                           else "Falha de comunicação Tuya. Verifique a conexão e a configuração local.")
                light.send({"id": request.get("id") if isinstance(request, dict) else None,
                            "type": "result", "success": False, "error": message})
    finally:
        transport.close()


if __name__ == "__main__":
    run("home" if len(sys.argv) > 1 and sys.argv[1] == "home" else "light")
