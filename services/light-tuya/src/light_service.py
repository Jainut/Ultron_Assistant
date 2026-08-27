from __future__ import annotations

import json
import os
import sys
from pathlib import Path
import time
import colorsys
import socket

import tinytuya


ROOT_DIR = Path(__file__).resolve().parent.parent

DEVICE_FILE = ROOT_DIR / "devices.json"
CLOUD_FILE = ROOT_DIR / "tinytuya.json"

DEVICE_NAME = "Smart color"

_cloud_instance = None
_cloud_device_id: str | None = None
_cloud_state: dict = {}


def get_cloud():
    global _cloud_instance
    global _cloud_device_id

    if _cloud_instance is not None and _cloud_device_id:
        return _cloud_instance, _cloud_device_id

    if not CLOUD_FILE.exists():
        raise FileNotFoundError(
            f"Configuração Tuya Cloud não encontrada: {CLOUD_FILE}"
        )

    config = json.loads(CLOUD_FILE.read_text(encoding="utf-8"))
    _cloud_instance = tinytuya.Cloud(
        apiRegion=config["apiRegion"],
        apiKey=config["apiKey"],
        apiSecret=config["apiSecret"],
        apiDeviceID=config["apiDeviceID"],
    )
    _cloud_device_id = config["apiDeviceID"]
    return _cloud_instance, _cloud_device_id


def cloud_fallback(arguments: list[str]) -> dict:
    global _cloud_state
    cloud, device_id = get_cloud()
    action = arguments[0].lower()
    optimistic_updates: dict = {}

    if action == "status":
        result = cloud.getstatus(device_id)
    else:
        commands: list[dict] = []

        if action in ("on", "off"):
            optimistic_updates["switch_led"] = action == "on"
            commands.append({
                "code": "switch_led",
                "value": action == "on",
            })

        elif action == "brightness":
            brightness = int(arguments[1])
            optimistic_updates["bright_value_v2"] = max(10, brightness * 10)
            commands.append({
                "code": "bright_value_v2",
                "value": max(10, brightness * 10),
            })

        elif action == "white":
            brightness = int(arguments[1])
            temperature = int(arguments[2])
            optimistic_updates.update({
                "work_mode": "white",
                "bright_value_v2": max(10, brightness * 10),
                "temp_value_v2": temperature * 10,
            })
            commands.extend([
                {"code": "work_mode", "value": "white"},
                {
                    "code": "bright_value_v2",
                    "value": max(10, brightness * 10),
                },
                {
                    "code": "temp_value_v2",
                    "value": temperature * 10,
                },
            ])

        elif action == "color":
            red, green, blue = map(int, arguments[1:4])
            hue, saturation, value = colorsys.rgb_to_hsv(
                red / 255,
                green / 255,
                blue / 255,
            )
            optimistic_updates.update({
                "work_mode": "colour",
                "colour_data_v2": {
                    "h": round(hue * 360),
                    "s": round(saturation * 1000),
                    "v": round(value * 1000),
                },
            })
            commands.extend([
                {"code": "work_mode", "value": "colour"},
                {
                    "code": "colour_data_v2",
                    "value": {
                        "h": round(hue * 360),
                        "s": round(saturation * 1000),
                        "v": round(value * 1000),
                    },
                },
            ])

        else:
            raise ValueError(f"Ação desconhecida: {action}")

        result = cloud.sendcommand(
            device_id,
            {"commands": commands},
        )

    if not isinstance(result, dict) or not result.get("success"):
        raise RuntimeError(
            f"Fallback Tuya Cloud falhou: {result}"
        )

    fast_confirmation = (
        action != "status"
        and os.getenv("ULTRON_TUYA_FAST_CONFIRM", "0") == "1"
    )

    if fast_confirmation:
        _cloud_state.update(optimistic_updates)
        state = dict(_cloud_state)
    else:
        if action != "status":
            time.sleep(0.5)

        status_result = result if action == "status" else cloud.getstatus(device_id)
        if not isinstance(status_result, dict) or not status_result.get("success"):
            raise RuntimeError("A Tuya não retornou uma leitura válida do estado.")
        state = {
            item["code"]: item.get("value")
            for item in status_result.get("result", [])
            if isinstance(item, dict) and "code" in item
        } if isinstance(status_result, dict) else {}
        _cloud_state = state

    if not fast_confirmation and action == "on" and state.get("switch_led") is not True:
        raise RuntimeError("A nuvem Tuya não confirmou que a lâmpada ligou.")

    if not fast_confirmation and action == "off" and state.get("switch_led") is not False:
        raise RuntimeError("A nuvem Tuya não confirmou que a lâmpada desligou.")

    confirmed = not fast_confirmation and (
        isinstance(state.get("switch_led"), bool) if action == "status"
        else all(state.get(code) == value for code, value in optimistic_updates.items())
    )
    return {
        "success": True,
        "action": action,
        "transport": "tuya_cloud",
        "confirmed": confirmed,
        "optimistic": fast_confirmation,
        "status": "confirmed" if confirmed else "optimistic" if fast_confirmation else "unknown",
        "message": "Estado real ainda não confirmado." if not confirmed and not fast_confirmation else None,
        "state": {
            "is_on": state.get("switch_led"),
            "mode": state.get("work_mode"),
            "brightness": state.get("bright_value_v2"),
            "temperature": state.get("temp_value_v2"),
        },
    }


def run_cloud_server() -> None:
    for line in sys.stdin:
        request = None

        try:
            request = json.loads(line)
            arguments = [str(value) for value in request.get("arguments", [])]
            result = cloud_fallback(arguments)
            result.update({
                "id": request.get("id"),
                "type": "result",
            })
            send(result)

        except Exception as error:
            send({
                "id": request.get("id") if request else None,
                "type": "result",
                "success": False,
                "error": str(error),
            })


def ensure_tuya_success(
    result,
    action: str,
):
    if isinstance(result, dict):
        if "Err" in result or "Error" in result:
            error_code = result.get("Err", "desconhecido")
            error_message = result.get(
                "Error",
                "Erro desconhecido",
            )

            raise RuntimeError(
                f"{action} falhou: "
                f"[{error_code}] {error_message}"
            )

    return result


def read_state(
    bulb: tinytuya.BulbDevice,
) -> dict:
    state = bulb.state()

    ensure_tuya_success(
        state,
        "Leitura de estado",
    )

    if not isinstance(state, dict):
        raise RuntimeError(
            "A lâmpada retornou um estado inválido."
        )

    return state

def send(data: dict) -> None:
    print(
        json.dumps(
            data,
            ensure_ascii=False,
        ),
        flush=True,
    )


def load_device() -> dict:
    if not DEVICE_FILE.exists():
        raise FileNotFoundError(
            f"devices.json não encontrado: {DEVICE_FILE}"
        )

    devices = json.loads(
        DEVICE_FILE.read_text(
            encoding="utf-8"
        )
    )

    for device in devices:
        name = str(
            device.get("name", "")
        ).lower()

        if name == DEVICE_NAME.lower():
            return device

    raise RuntimeError(
        f'Lâmpada "{DEVICE_NAME}" não encontrada.'
    )


def get_bulb(probe: bool = True) -> tinytuya.BulbDevice:
    device = load_device()

    if probe:
        try:
            connection = socket.create_connection(
                (device["ip"], 6668),
                timeout=0.6,
            )
            connection.close()
        except OSError as error:
            raise ConnectionError(
                "Dispositivo Tuya local indisponível."
            ) from error

    bulb = tinytuya.BulbDevice(
        device["id"],
        device["ip"],
        device["key"],
    )

    bulb.set_version(
        float(
            device.get(
                "version",
                3.5,
            )
        )
    )

    return bulb


def main() -> None:
    if len(sys.argv) < 2:
        raise ValueError(
            "Informe uma ação."
        )

    action = sys.argv[1].lower()

    if os.getenv("ULTRON_TUYA_SKIP_LOCAL") == "1":
        raise ConnectionError(
            "Transporte local ignorado; usando Tuya Cloud previamente validada."
        )

    bulb = get_bulb()

    # Descobre automaticamente se é
    # Type A, B ou C e seus DPS.
    bulb.detect_bulb()


    if action == "status":
        result = bulb.state()

        send({
            "success": True,
            "action": "status",
            "state": result,
            "bulb_type": bulb.bulb_type,
        })

        return


    if action == "on":
        result = bulb.turn_on()

        ensure_tuya_success(
            result,
            "Ligar lâmpada",
        )

        time.sleep(0.15)

        state = read_state(bulb)

        if not state.get("is_on"):
            raise RuntimeError(
                "O comando foi enviado, mas a lâmpada "
                "não confirmou que está ligada."
            )

        send({
            "success": True,
            "action": "on",
            "confirmed": True,
            "state": state,
        })

        return


    if action == "off":
        result = bulb.turn_off()

        ensure_tuya_success(
            result,
            "Desligar lâmpada",
        )

        time.sleep(0.15)

        state = read_state(bulb)

        if state.get("is_on"):
            raise RuntimeError(
                "O comando foi enviado, mas a lâmpada "
                "não confirmou que está desligada."
            )

        send({
            "success": True,
            "action": "off",
            "confirmed": True,
            "state": state,
        })

        return


    if action == "color":
        if len(sys.argv) < 5:
            raise ValueError(
                "Uso: color R G B"
            )

        red = int(sys.argv[2])
        green = int(sys.argv[3])
        blue = int(sys.argv[4])

        for value in (
            red,
            green,
            blue,
        ):
            if not 0 <= value <= 255:
                raise ValueError(
                    "RGB deve estar entre 0 e 255."
                )

        result = bulb.set_colour(
            red,
            green,
            blue,
        )

        send({
            "success": True,
            "action": "color",
            "rgb": {
                "red": red,
                "green": green,
                "blue": blue,
            },
            "result": result,
        })

        return


    if action == "brightness":
        if len(sys.argv) < 3:
            raise ValueError(
                "Uso: brightness PERCENTUAL"
            )

        brightness = int(
            sys.argv[2]
        )

        if not 0 <= brightness <= 100:
            raise ValueError(
                "Brilho deve estar entre 0 e 100."
            )

        result = (
            bulb.set_brightness_percentage(
                brightness
            )
        )

        ensure_tuya_success(
            result,
            "Alterar brilho",
        )

        time.sleep(0.15)

        state = read_state(bulb)

        actual_brightness = (
            bulb.get_brightness_percentage(
                state
            )
        )

        if (
            isinstance(
                actual_brightness,
                (int, float),
            )
            and abs(
                actual_brightness
                - brightness
            ) > 3
        ):
            raise RuntimeError(
                f"Brilho solicitado: {brightness}%. "
                f"Brilho confirmado: "
                f"{actual_brightness}%."
            )

        send({
            "success": True,
            "action": "brightness",
            "requested_brightness": brightness,
            "actual_brightness": actual_brightness,
            "confirmed": True,
        })

        return


    if action == "white":
        if len(sys.argv) < 4:
            raise ValueError(
                "Uso: white BRILHO TEMPERATURA"
            )

        brightness = int(
            sys.argv[2]
        )

        temperature = int(
            sys.argv[3]
        )

        result = bulb.set_white_percentage(
            brightness=brightness,
            colourtemp=temperature,
        )

        ensure_tuya_success(
            result,
            "Alterar luz branca",
        )

        time.sleep(0.15)

        state = read_state(bulb)

        mode = bulb.get_mode(state)

        actual_brightness = (
            bulb.get_brightness_percentage(
                state
            )
        )

        actual_temperature = (
            bulb.get_colourtemp_percentage(
                state
            )
        )

        if mode != "white":
            raise RuntimeError(
                f"A lâmpada não confirmou o modo "
                f"branco. Modo atual: {mode}"
            )

        send({
            "success": True,
            "action": "white",
            "confirmed": True,
            "mode": mode,
            "brightness": actual_brightness,
            "temperature": actual_temperature,
        })

        return

    raise ValueError(
        f"Ação desconhecida: {action}"
    )


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--cloud-server":
        run_cloud_server()
        raise SystemExit(0)

    try:
        main()

    except Exception as local_error:
        try:
            fallback_result = cloud_fallback(
                sys.argv[1:]
            )
            send(fallback_result)

        except Exception as cloud_error:
            send({
                "success": False,
                "error": str(local_error),
                "fallback_error": str(cloud_error),
            })

            raise
