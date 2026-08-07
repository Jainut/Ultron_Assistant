import wave

import sounddevice as sd


INPUT_DEVICE = 17
DURATION_SECONDS = 5

device_info = sd.query_devices(
    INPUT_DEVICE,
    "input",
)

sample_rate = int(
    device_info["default_samplerate"]
)

print("Dispositivo:", device_info["name"])
print("Taxa:", sample_rate)
print("Gravando por 5 segundos...")

audio = sd.rec(
    int(DURATION_SECONDS * sample_rate),
    samplerate=sample_rate,
    channels=1,
    dtype="int16",
    device=INPUT_DEVICE,
)

sd.wait()

with wave.open("mic-test.wav", "wb") as file:
    file.setnchannels(1)
    file.setsampwidth(2)
    file.setframerate(sample_rate)
    file.writeframes(audio.tobytes())

print("Arquivo salvo: mic-test.wav")