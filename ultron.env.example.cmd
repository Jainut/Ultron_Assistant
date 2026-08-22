@echo off
rem Copie este arquivo para ultron.env.cmd e ajuste os valores locais.

rem Voz original do Ultron.
set "ULTRON_TTS_PITCH_STEPS=-5.5"
set "ULTRON_TTS_SPEED=0.85"

set "ULTRON_MODEL=qwen3:4b-instruct"
rem Vazio = large-v3-turbo Q5 quando disponível, senão medium/small.
set "ULTRON_WHISPER_MODEL="
set "ULTRON_WHISPER_THREADS=4"
set "ULTRON_WHISPER_LANGUAGE=pt"
set "ULTRON_WHISPER_BEAM_SIZE=2"
set "ULTRON_WHISPER_BEST_OF=2"
set "ULTRON_WHISPER_NO_SPEECH_THRESHOLD=0.5"
set "ULTRON_WHISPER_TERMS=Ultron,Visual Studio Code,VS Code,Zen Browser,Spotify,YouTube,GitHub,Supabase,Vercel,Render,Node.js,TypeScript"

rem Ajustes de microfone, endpoint adaptativo e WebRTC VAD.
set "ULTRON_INPUT_DEVICE=17"
set "ULTRON_ENDPOINT_MIN_MS=280"
set "ULTRON_ENDPOINT_TARGET_MS=320"
set "ULTRON_ENDPOINT_MAX_MS=400"
set "ULTRON_MIN_VOICED_MS=120"
set "ULTRON_VAD_ENABLED=1"
set "ULTRON_VAD_MODE=2"
set "ULTRON_SPEECH_THRESHOLD=0.015"
set "ULTRON_BARGE_SPEECH_THRESHOLD=0.035"
set "ULTRON_BARGE_START_BLOCKS=2"
set "ULTRON_MAX_SPEECH_SECONDS=20"

rem Referência acústica conservadora para não confundir o TTS com barge-in.
set "ULTRON_ECHO_REFERENCE_ENABLED=1"
set "ULTRON_ECHO_DELAY_MIN_MS=0"
set "ULTRON_ECHO_DELAY_MAX_MS=250"
set "ULTRON_ECHO_DELAY_STEP_MS=5"
set "ULTRON_ECHO_CORRELATION_THRESHOLD=0.97"
set "ULTRON_ECHO_RESIDUAL_RATIO_THRESHOLD=0.18"
set "ULTRON_ECHO_TELEMETRY_INTERVAL_MS=1000"

rem 0 usa confirmação otimista no daemon Tuya; 1 relê o estado a cada comando.
set "ULTRON_TUYA_CONFIRM_COMMANDS=0"

rem Roots adicionais para busca de arquivos, separados por ponto e vírgula.
set "ULTRON_SEARCH_ROOTS="

rem Integrações Google (OAuth Desktop). Não commite credenciais reais.
set "ULTRON_GOOGLE_CLIENT_ID="
set "ULTRON_GOOGLE_CLIENT_SECRET="
set "ULTRON_GOOGLE_TIME_ZONE=America/Sao_Paulo"
rem Opcional: sobrescreve os scopes padrão de Gmail/Tasks/Calendar.
set "ULTRON_GOOGLE_SCOPES="

rem Defina como 1 somente para investigar desempenho e integrações.
set "ULTRON_DEBUG=0"
