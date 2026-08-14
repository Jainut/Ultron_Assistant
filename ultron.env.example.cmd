@echo off
rem Copie este arquivo para ultron.env.cmd e ajuste os valores locais.

rem Voz original do Ultron.
set "ULTRON_TTS_PITCH_STEPS=-5.5"
set "ULTRON_TTS_SPEED=0.85"

set "ULTRON_MODEL=qwen3:4b-instruct"
set "ULTRON_WHISPER_MODEL=ggml-medium.bin"
set "ULTRON_WHISPER_THREADS=4"
set "ULTRON_WHISPER_LANGUAGE=pt"
set "ULTRON_WHISPER_BEAM_SIZE=2"
set "ULTRON_WHISPER_BEST_OF=2"
set "ULTRON_WHISPER_NO_SPEECH_THRESHOLD=0.5"
set "ULTRON_WHISPER_TERMS=Ultron,Visual Studio Code,VS Code,Zen Browser,Spotify,YouTube,GitHub,Supabase,Vercel,Render,Node.js,TypeScript"

rem Ajustes de microfone/VAD.
set "ULTRON_INPUT_DEVICE=17"
set "ULTRON_SILENCE_SECONDS=0.75"
set "ULTRON_SPEECH_THRESHOLD=0.015"
set "ULTRON_BARGE_SPEECH_THRESHOLD=0.035"
set "ULTRON_BARGE_START_BLOCKS=2"
set "ULTRON_MIN_SPEECH_SECONDS=0.25"
set "ULTRON_MAX_SPEECH_SECONDS=20"

rem 0 usa confirmação otimista no daemon Tuya; 1 relê o estado a cada comando.
set "ULTRON_TUYA_CONFIRM_COMMANDS=0"

rem Roots adicionais para busca de arquivos, separados por ponto e vírgula.
set "ULTRON_SEARCH_ROOTS="

rem Defina como 1 somente para investigar desempenho e integrações.
set "ULTRON_DEBUG=0"
