from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

import tinytuya


ROOT_DIR = Path(__file__).resolve().parent.parent
CLOUD_FILE = ROOT_DIR / "tinytuya.json"


def send(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False), flush=True)


def normalize(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(
        character
        for character in decomposed
        if unicodedata.category(character) != "Mn"
    ).lower().strip()


def get_cloud() -> tinytuya.Cloud:
    if not CLOUD_FILE.exists():
        raise FileNotFoundError(
            f"Credenciais Tuya Cloud não encontradas: {CLOUD_FILE}"
        )

    config = json.loads(CLOUD_FILE.read_text(encoding="utf-8"))
    return tinytuya.Cloud(
        apiRegion=config["apiRegion"],
        apiKey=config["apiKey"],
        apiSecret=config["apiSecret"],
        apiDeviceID=config["apiDeviceID"],
    )


def list_devices(cloud: tinytuya.Cloud) -> list[dict]:
    devices = cloud.getdevices()

    if not isinstance(devices, list):
        raise RuntimeError(f"Tuya Cloud não retornou uma lista válida: {devices}")

    return devices


def public_device(device: dict) -> dict:
    category = str(device.get("category", ""))
    product_name = str(
        device.get("product_name")
        or device.get("product_id")
        or ""
    )
    identity = normalize(
        f"{device.get('name', '')} {category} {product_name}"
    )

    if any(word in identity for word in ("lamp", "light", "bulb", "dj")):
        kind = "light"
    elif any(word in identity for word in ("switch", "plug", "tomada", "cz")):
        kind = "switch"
    else:
        kind = "unknown"

    return {
        "id": str(device.get("id", "")),
        "name": str(device.get("name") or product_name or "Dispositivo Tuya"),
        "mac": str(device.get("mac") or ""),
        "ip": str(device.get("ip") or device.get("last_ip") or ""),
        "category": category,
        "model": product_name,
        "kind": kind,
    }


def choose_switch_code(cloud: tinytuya.Cloud, device_id: str) -> str:
    functions = cloud.getfunctions(device_id)

    if isinstance(functions, dict) and functions.get("success"):
        result = functions.get("result", {})
        entries = result.get("functions", []) if isinstance(result, dict) else []

        for entry in entries:
            if not isinstance(entry, dict):
                continue

            code = str(entry.get("code", ""))
            value_type = str(entry.get("type", "")).lower()

            if code.startswith("switch") and value_type in ("bool", "boolean"):
                return code

    status = cloud.getstatus(device_id)

    if isinstance(status, dict) and status.get("success"):
        for entry in status.get("result", []):
            if not isinstance(entry, dict):
                continue

            code = str(entry.get("code", ""))

            if code.startswith("switch") and isinstance(entry.get("value"), bool):
                return code

    raise RuntimeError("O dispositivo Tuya não expõe um controle liga/desliga compatível.")


def main() -> None:
    action = sys.argv[1].lower() if len(sys.argv) > 1 else "discover"
    cloud = get_cloud()

    if action == "discover":
        send({
            "success": True,
            "devices": [public_device(device) for device in list_devices(cloud)],
        })
        return

    if action != "control" or len(sys.argv) < 4:
        raise ValueError("Uso: home_service.py discover | control DEVICE_ID ACTION")

    device_id = sys.argv[2]
    requested_action = sys.argv[3].lower()

    if requested_action == "status":
        result = cloud.getstatus(device_id)
        if not isinstance(result, dict) or not result.get("success"):
            raise RuntimeError(f"Falha ao consultar o dispositivo Tuya: {result}")
        send({"success": True, "action": "status", "state": result.get("result")})
        return

    if requested_action not in ("on", "off", "toggle"):
        raise ValueError(f"Ação Tuya não suportada: {requested_action}")

    switch_code = choose_switch_code(cloud, device_id)
    desired_state = requested_action == "on"

    if requested_action == "toggle":
        status = cloud.getstatus(device_id)
        entries = status.get("result", []) if isinstance(status, dict) else []
        current = next(
            (
                bool(entry.get("value"))
                for entry in entries
                if isinstance(entry, dict) and entry.get("code") == switch_code
            ),
            False,
        )
        desired_state = not current

    result = cloud.sendcommand(device_id, {
        "commands": [{"code": switch_code, "value": desired_state}],
    })

    if not isinstance(result, dict) or not result.get("success"):
        raise RuntimeError(f"Falha ao controlar o dispositivo Tuya: {result}")

    send({
        "success": True,
        "action": requested_action,
        "switch_code": switch_code,
        "state": desired_state,
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        send({"success": False, "error": str(error)})
        raise
