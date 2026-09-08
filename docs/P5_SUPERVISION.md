# P5 — Supervisão limitada dos serviços e ciclo de vida da voz

Esta etapa acrescenta supervisão ao ciclo de vida existente. Não troca Whisper,
Kokoro, pitch, SpeechQueue, SpeechChunker, VAD, referência acústica, tools ou
protocolos de áudio. Não acrescenta dependências. As chamadas existentes
`start()`, `listen()`, `stop()` e os controles de playback continuam válidos.

## Contratos para integração

STT e TTS oferecem `start(signal?)`, `stop()`, `isReady()`,
`healthCheck(signal?)` e `onFailure(listener)`, que retorna um unsubscribe.
STT também aceita `listen(signal?)`. O primeiro caller é dono da inicialização;
chamadas simultâneas sem signal recebem a mesma promise. Cancelar um segundo
waiter cancela somente sua espera. Cancelar o dono encerra a inicialização.

`ServiceSupervisor` registra `{name, start, stop, health?, onFailure?, policy?}`.
As APIs são `start(name, signal?)`, `startAll(signal?)`, `checkNow(name)`,
`snapshot(name)`, `snapshots()`, `onStateChange(listener)`, `stop(name)` e
`stopAll()`. `startAll` retorna os snapshots mesmo se um serviço opcional falhar;
`start` rejeita ao esgotar o orçamento. O runtime decide como preservar entrada
por texto e sinalizar uma capacidade indisponível.

Use wrappers `stop: () => stt.stop()` e `stop: () => tts.stop()`; o signal do
supervisor não deve ser passado como argumento de `tts.stop`, cujo parâmetro
opcional é o motivo de erro usado internamente.

## Estados, retries e shutdown

Estados publicados: `starting`, `ready`, `degraded`, `restarting`, `failed` e
`stopped`. Cada snapshot inclui nome, tentativas, reinícios, timestamps e falha
saneada por fase. Não inclui mensagem de erro livre, transcrições, paths, tokens
ou bodies de APIs. Snapshots são cópias; observadores não podem derrubar o serviço.

Por padrão são permitidos dois reinícios, além da tentativa inicial. O backoff é
exponencial, começando em 500 ms e limitado a 10 s. Ficar brevemente `ready` não
zera esse orçamento: um serviço que cai repetidamente termina em `failed`.
Somente um `start` explícito depois de falhar/parar inicia novo orçamento. Uma
falha ao parar impede iniciar uma segunda cópia sobre um processo anterior.

`stopAll()` aborta startup, probes e backoff, remove timers/listeners e recusa
novos starts. Só são encerrados processos pertencentes à instância. Resultados,
erros e `ready` de gerações antigas não afetam a geração atual. Providers que
ignoram AbortSignal não prendem a espera do supervisor; o provider ainda precisa
implementar `stop()` idempotente que libere seus recursos reais.

O supervisor nunca recebe uma tool, nunca repete ações mutantes, rotinas ou jobs,
e não deve disparar novamente o evento `system.startup`. `health` deve ser uma
consulta sem efeitos colaterais. Serviços externos, como um Ollama já em execução,
devem usar adaptadores read-only, sem matar/recriar processos alheios.

`policy.probeWhenFailed` é `false` por padrão. Quando explicitamente `true`, um
serviço externo em `failed` continua recebendo somente probes `health` no intervalo
configurado ou por `checkNow`. Se recuperar, volta a `ready`, sem chamar `start`,
`stop`, replay de tool ou zerar o orçamento. A voz mantém a política fechada padrão.

## Limites padrão

Todos os limites abaixo aceitam override pelas opções do serviço/política, sem
alterar os defaults de modelo e voz já configurados.

| Operação | Limite padrão |
| --- | ---: |
| Startup STT completo | 90 s |
| Prontidão HTTP do Whisper | 60 s |
| Handshake da captura | 10 s |
| Probe HTTP STT | 1,5 s |
| Transcrição, incluindo leitura/HTTP/body | 60 s |
| Startup Kokoro | 180 s |
| Síntese Kokoro | 60 s |
| Playback persistente ou fallback | 120 s |
| ACK de cancel/flush do playback | 1,5 s |
| Supervisor: startup / health / stop | 180 s / 2 s / 5 s |
| Supervisor: intervalo de health | 30 s |

STT: `startupTimeoutMs`, `whisperStartupTimeoutMs`, `captureStartupTimeoutMs`,
`transcriptionTimeoutMs`, `healthTimeoutMs` e `pollIntervalMs`.
TTS: `startupTimeoutMs`, `synthesisTimeoutMs`, `playbackTimeoutMs` e
`playbackCancelTimeoutMs`.
Supervisor: `maxRestarts`, `startupTimeoutMs`, `healthTimeoutMs`,
`healthIntervalMs`, `stopTimeoutMs`, `backoffMs`, `maxBackoffMs` e
`probeWhenFailed`. `healthIntervalMs: 0` desliga o polling automático.

## STT: o que mudou

- Single-flight de startup; confirmação HTTP do Whisper **e** handshake real da
  captura são necessários para ficar pronto.
- Erros, exit/close e falhas de stdin/stdout/stderr encerram a sessão e rejeitam
  imediatamente a escuta pendente, sem esperar um `close` que pode não chegar.
- Os pipes de Whisper são drenados para evitar bloqueio por backpressure.
- Startup, GET e POST aceitam cancelamento e timeout. Timeout de inferência
  encerra a sessão, porque cancelar HTTP não garante que o decode no servidor
  parou; a supervisão pode então iniciar uma tentativa nova dentro do orçamento.
- Uma transcrição pertence a uma geração e a uma única escuta. Resultados
  cancelados/tardios não resolvem outra escuta nem contaminam o prompt contextual.
- Estado de playback e referência acústica ativa são preservados mesmo quando a
  captura está indisponível. O handshake de uma captura nova reaplica esse estado
  **antes** de liberar `start()`/`listen()`, inclusive quando o TTS começou antes
  do Whisper. Referências terminadas e playback desativado enquanto offline não
  ressurgem; um fim atrasado de referência antiga não apaga a mais recente.
- `stop()` rejeita a escuta com AbortError; o WAV temporário continua sendo
  removido. O protocolo de playback/reference e as métricas existentes permanecem.

Enquanto há inferência, `healthCheck` verifica ownership/vida dos processos sem
enfileirar GET atrás do decode. O deadline da inferência protege esse intervalo.
Fora dele, faz um GET limitado na rota já usada pelo Whisper existente.

## TTS: prazo e segurança de reprodução

`isReady`/`healthCheck` comprovam apenas processo próprio e handshake. O protocolo
atual não fornece ping do motor Kokoro; essa limitação não é tratada como uma
medição de saúde remota. Os deadlines por request detectam trabalho travado.

Timeout de síntese/playback/cancel/flush encerra o worker, rejeita pendências e
notifica falha uma única vez. O ACK `playback_flushed` não substitui um terminal
`playback_cancelled`/`playback_finished` de cada áudio: ambos são limitados. Assim,
`SpeechQueue.waitUntilIdle()` não fica aguardando indefinidamente um player morto.

Cancelamento de síntese é cooperativo em Kokoro. O caller é rejeitado imediatamente,
mas o deadline original de 60 s é mantido até a resposta terminal do Python. Não
se aplica o limite de 1,5 s do **player** a um kernel de síntese ainda em execução.

Sem ACK de início, timeout/queda de processo não prova que o áudio não começou.
Portanto não há replay automático por fallback nesses casos, nem após cancel/flush.
O player legado permanece disponível quando a capability persistente não existe
ou quando o backend recusa explicitamente o playback antes do início/cancelamento.
O fallback também é cancelável, limitado e liberado durante shutdown.

## Validação sem microfone, modelo ou dispositivos reais

Testes usam JSON-lines fake children, fetch simulado e WAVs fictícios em diretórios
temporários. Não iniciam Python, Whisper, Kokoro, PowerShell de áudio ou microfone.
Cobrem startup single-flight, spawn/pipe/close/fatal, abort, restart com eventos
antigos, timeouts, corrida failure/health/ready, orçamento de reinícios, shutdown,
probes read-only, listeners, snapshots e deadlines de síntese/playback/flush.

Na raiz, execute `npm run check`. Em `apps/core`, a suíte focada é:

```powershell
node --import tsx --test tests/service-supervisor.test.ts tests/stt-lifecycle.test.ts tests/tts-startup.test.ts tests/tts-deadlines.test.ts tests/persistent-audio-player.test.ts tests/playback-reference.test.ts tests/stt-capture-contract.test.ts tests/calibration-lifecycle.test.ts tests/barge-in-calibration.test.ts
```

Os testes da fila, calibração observe-only e referências acústicas anteriores são
incluídos como regressão. O teste negativo do player já existente emite um log de
erro esperado. Nenhuma duração dos doubles demonstra latência real de voz.

Ainda é necessária validação física autorizada de recuperação do microfone,
queda/reinício dos processos, cancelamento sob carga, playback real, privacidade
acústica e consumo de CPU/RAM na máquina do usuário. Os limites podem precisar de
calibração para modelos grandes, sem mudar modelo/pitch automaticamente.
