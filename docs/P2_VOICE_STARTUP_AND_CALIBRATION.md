# P2 — startup de voz e calibração segura

## Implementado

- STT e Kokoro iniciam em paralelo. O core continua aguardando ambos antes de
  anunciar prontidão; não removeu warm-up, pitch, streaming ou terminal fallback.
- O startup do TTS é single-flight, tem timeout e limpa solicitações pendentes
  após falha de processo, protocolo ou stdin. Eventos de processos antigos não
  invalidam uma nova sessão.
- Telemetria opcional no `ready` separa imports, pipeline, warm-up Kokoro,
  warm-up dos efeitos, player e tempo total. Mensagens antigas continuam válidas.
- Calibrador guiado de barge-in usa SpeechQueue e player persistente existentes,
  sem iniciar Whisper, Ollama, tools, discovery ou automações.
- Captura de diagnóstico exige handshake `observeOnly: true`: não grava WAV,
  não transcreve e não guarda áudio. Um evento com áudio é falha de privacidade.
- Ctrl+C cancela inicialização e reprodução; processos tardios e falhas entre
  rodadas não deixam promises pendentes. O modo normal mantém seu fallback.

## Uso manual, quando puder falar perto do microfone

Encerre a instância de voz antes de calibrar. A ferramenta verifica as portas
do HUD e Whisper e recusa conflito. Ela **vai reproduzir áudio e abrir o
microfone** apenas quando executada deliberadamente:

```powershell
npm run calibrate:barge-in -- --help
npm run calibrate:barge-in -- --quick
npm run calibrate:barge-in -- --gate --output data/barge-in-calibration.json
```

Sem `--output`, não há relatório em disco; um arquivo existente não é
sobrescrito. O relatório contém apenas métricas e condições, sem áudio,
transcrições, nomes de dispositivos ou caminhos pessoais.

O gate cobre volumes 25/50/100% e distâncias perto/longe. Exige pelo menos
cinco interrupções e 300 segundos de eco em **cada** condição (30 tentativas e
30 minutos totais), tempos completos e finitos, VAD WebRTC e evidência de
referência acústica. Ausência de evidência produz **inconclusivo**, não aprovado.
Isso é um filtro conservador de eco, não certificação de AEC completo.

## Validação desta revisão

- `npm run check` e `npm run build`: aprovados.
- Testes focados TS de startup, fila/calibrador e lifecycle: 31/31.
- Testes Python de speech-input: 18/18.
- Teste Python do protocolo de startup Kokoro: 1/1.
- Testes não abriram áudio/microfone nem acionaram dispositivos.

## Benchmark e pendências

Antes, STT aguardava todo o startup do TTS; agora as duas inicializações
independentes se sobrepõem. Ainda falta medir cold-start comparável antes/depois
na máquina e avaliar contenção de CPU. Não há porcentagem de ganho comprovada.

O perfil de voz e o pitch foram preservados. A calibração física com caixas e
microfone, assim como o corpus real PT-BR de Whisper, continuam pendentes.
Os resultados sintéticos anteriores não substituem essas medições.

Próximo bloco: casa inteligente (daemon Tuya, inventário e confirmação de estado)
e o HUD neural azul solicitado, sem modificar o contrato das tools.
