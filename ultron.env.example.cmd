@echo off
rem Copie este arquivo para ultron.env.cmd e ajuste os valores locais.

rem Voz original do Ultron.
set "ULTRON_TTS_PITCH_STEPS=-5.5"
set "ULTRON_TTS_SPEED=0.85"

set "ULTRON_MODEL=qwen3:4b-instruct"
set "ULTRON_WHISPER_MODEL=ggml-medium.bin"
set "ULTRON_WHISPER_THREADS=4"

rem Ajustes de microfone/VAD.
set "ULTRON_INPUT_DEVICE=17"
set "ULTRON_SILENCE_SECONDS=0.75"
set "ULTRON_SPEECH_THRESHOLD=0.015"

rem Defina como 1 somente para investigar desempenho e integrações.
set "ULTRON_DEBUG=0"
