# Auditoria P2: Whisper, barge-in e referência de playback

Data da coleta: **2026-08-20**. O documento começou como auditoria offline e foi
atualizado depois da implementação P2. O pipeline ativo passou a usar endpoint
adaptativo, WebRTC VAD, métricas de endpoint e player Kokoro persistente. A voz,
velocidade e pitch existentes foram preservados.

## Como reproduzir

O harness usa exclusivamente arquivos locais e nunca acessa a rede:

```powershell
node scripts/audio/whisper-benchmark.mjs --inventory-only
node scripts/audio/whisper-benchmark.mjs --runs 3 --output .tmp/whisper-benchmark.json
node --test scripts/audio/whisper-benchmark.test.mjs
```

Para adicionar gravações próprias, copie
`scripts/audio/whisper-benchmark.manifest.json`, aponte `samples[].audio` para os
WAVs e informe uma transcrição humana em `reference`. `criticalTerms` deve conter
somente termos que realmente são falados naquele WAV. Em seguida, execute com
`--manifest caminho/do/manifesto.json`. Caminhos absolutos e relativos à raiz do
projeto são aceitos.

O relatório separa o tempo de carregamento do modelo do restante do tempo do
CLI. O Ultron usa `whisper-server.exe` persistente, então o número mais próximo
da operação normal é `processingExcludingLoadMs`, ainda que ele continue sendo
uma aproximação e não substitua uma medição HTTP no servidor real.

## Inventário local observado

| Item | Estado observado |
|---|---:|
| `whisper-cli.exe` | disponível |
| GPU Vulkan | AMD Radeon RX 6600, FP16 |
| `ggml-small.bin` | 487.601.967 bytes; 487,01 MiB reportados na GPU |
| `ggml-medium.bin` | 1.533.763.059 bytes; 1.533,14 MiB reportados na GPU |
| `ggml-large-v3-turbo-q5_0.bin` | 574.041.195 bytes; 573,40 MiB reportados na GPU |
| `jfk.wav` | 11 s, inglês, referência humana conhecida |
| `mic-test.wav` | 5 s, português, sem referência humana confiável |
| Python do `speech-input` | 3.12.10; `sounddevice` 0.5.5; NumPy 2.5.1 |
| `webrtcvad` no venv ativo | **2.0.14 instalado**; fallback RMS preservado |

Existe também um arquivo Silero chamado
`for-tests-silero-v6.2.0-ggml.bin` em `services/speech-whisper/models`, mas ele
não está integrado ao capturador atual e o próprio nome o caracteriza como
artefato de testes. Não deve ser habilitado sem validar formato, licença e
latência.

## Medições obtidas

Parâmetros: RX 6600/Vulkan, 4 threads, beam size 2, best-of 2, temperatura 0,
no-speech threshold 0,5 e flash attention. Cada linha abaixo é uma execução do
CLI e, portanto, inclui uma carga nova do modelo.

| Modelo / WAV | Parede | Load | Processamento sem load | WER |
|---|---:|---:|---:|---:|
| small / JFK 11 s | 1.584 ms | 696 ms | 694 ms | 0/22 = **0%** |
| medium / JFK 11 s | 3.811 ms | 2.104 ms | 1.492 ms | 0/22 = **0%** |
| large-v3-turbo Q5 / JFK 11 s | 3.141 ms | 776 ms | 2.161 ms | 0/22 = **0%** |
| small / mic-test 5 s | 1.200 ms | 604 ms | 417 ms | indisponível |
| medium / mic-test 5 s | 3.669 ms | 1.846 ms | 1.531 ms | indisponível |
| large-v3-turbo Q5 / mic-test 5 s | 2.676 ms | 704 ms | 1.777 ms | indisponível |

Os três modelos produziram a referência JFK exatamente após normalização. Isso
não prova equivalência em português brasileiro: há apenas um WAV rotulado e ele
é inglês. O `mic-test.wav` não tem transcrição humana, então usá-lo para WER ou
acurácia dos termos seria fabricar uma medida. Também não há corpus local
rotulado contendo VS Code, Zen Browser, Spotify e os demais termos críticos.

Foi feita ainda uma medição complementar de uma única amostra pt-BR sintética,
gerada com a própria voz configurada do Ultron e contendo comandos reais. Ela
não é um corpus humano e por isso não foi adicionada como prova definitiva ao
manifesto, mas ajuda a detectar perda de termos de domínio:

| Modelo | WER (31 palavras) | Recall Ultron/VS Code/Fakeboxd/Spotify |
|---|---:|---:|
| small | 8/31 = **25,8%** | 2/4 = **50%** |
| medium | 5/31 = **16,1%** | 4/4 = **100%** |
| large-v3-turbo Q5 | 1/31 = **3,2%** | 4/4 = **100%** |

No servidor persistente, em uma execução controlada do WAV de 11 s, `small`,
`medium` e Turbo Q5 levaram aproximadamente 542 ms, 5.641 ms e 3.307 ms. Como
o `small` perdeu termos essenciais e o Turbo Q5 foi mais preciso, mais rápido e
menor que o `medium`, o runtime agora prefere o Turbo Q5 **quando seu arquivo já
existe**, preservando fallback para `medium` e `small`. Ainda é necessário medir
20–50 frases humanas pt-BR, com ruído e distâncias variadas, antes de tratar os
números de precisão como definitivos.

## Estado atual do barge-in

O caminho atual preserva o microfone durante o playback. O Core envia somente um
booleano `playback active` ao processo Python. Durante playback, o capturador
aumenta o limiar RMS e exige dois blocos positivos; quando detecta
`speech_start`, o Core interrompe a fila e cancela o turno anterior. A
`SpeechQueue` invalida a geração, cancela TTS e envia `flush_playback` ao player
persistente.

O WebRTC VAD está ativo no venv observado e o RMS permanece como fallback.
Mesmo assim, VAD distingue voz de ruído, não a voz humana do áudio reproduzido
pelo próprio Ultron. O filtro textual
posterior consegue descartar algumas transcrições parecidas com a fala do
assistente, mas ocorre depois de `speech_start`; assim, um eco pode interromper o
playback antes de ser reconhecido como eco.

O player Kokoro agora é persistente e expõe o evento exato `playback_started` ao
Core. Ele ainda não envia PCM/timestamp ao capturador, portanto falta o sinal de
referência necessário para AEC ou correlação acústica. O SoundPlayer em
PowerShell foi mantido apenas como fallback compatível.

## Menor integração de referência compatível

A primeira migração pode preservar todas as APIs públicas existentes:

1. O protocolo persistente passa a encaminhar ao capturador a referência `{
   path, generation, startedAt }` derivada do `playback_started` já existente.
2. `SpeechToTextService` ganha um controle adicional, sem remover
   `setPlaybackActive`: `playback_reference` com caminho, geração e início.
3. O capturador Python lê o WAV TTS, converte para mono/48 kHz e mantém uma janela
   da referência alinhada por busca limitada de atraso.
4. Antes de emitir `speech_start` durante playback, calcula correlação
   normalizada/coerência. Energia alta e correlação alta é eco provável; energia
   alta e correlação baixa por 2–3 blocos é fala do usuário. Se a referência
   faltar ou estiver inválida, conserva o limiar atual como fallback.
5. `speech_start` continua usando o mesmo cancelamento já funcional da
   `SpeechQueue`; a mudança fica isolada à decisão anterior ao evento.

Isso é supressão de eco orientada por referência, não AEC adaptativo completo.
É a menor etapa que resolve o falso barge-in sem reescrever STT/TTS. Para AEC
real, o passo posterior é um serviço duplex persistente que possua captura e
renderização, com WebRTC Audio Processing Module (AEC3). Apenas WASAPI ou
`sounddevice` não fornecem AEC automaticamente.

## Critérios de aceitação antes de integrar

- Playback do Ultron sozinho por 30 minutos não deve emitir `speech_start`.
- Voz do usuário sobre o playback deve interromper em menos de 200 ms p95.
- A fala reproduzida nunca pode virar comando/tool, mesmo após falsa detecção.
- O teste deve cobrir alto-falante em 25%, 50% e 100%, três distâncias do
  microfone e pelo menos um ambiente ruidoso.
- Referência ausente, WAV removido e geração antiga devem degradar para o
  comportamento atual sem derrubar o capturador.
- Logs devem registrar apenas métricas (`correlation`, atraso, decisão e
  latência); áudio e transcrições permanecem locais e não são persistidos por
  padrão.

## Bloqueios desta auditoria

- Não existe corpus pt-BR rotulado local suficiente para comparar precisão.
- Não existem WAVs rotulados com os termos críticos; o harness deixa a métrica
  nula em vez de inventá-la.
- Não existe referência de playback nem gravação simultânea microfone+speaker
  para medir ERLE, falso barge-in ou atraso acústico.
- O benchmark do CLI recarrega modelos; medir o caminho real requer um harness
  HTTP separado contra o servidor persistente, com o Ultron parado para não
  disputar a porta/modelo.
