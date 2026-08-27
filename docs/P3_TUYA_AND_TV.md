# P3 — transportes Tuya e honestidade no controle da TV

## Implementado

- `controlLight(options, context)` e o resultado JSON continuam compatíveis.
  O caminho normal usa um worker Python persistente desde a primeira chamada,
  tanto para transporte local quanto Cloud.
- TinyTuya instalado (1.20.0) mantém socket local persistente, configuração e
  identificação da lâmpada. Não há probe TCP ou `detect_bulb()` a cada comando.
- Falha local abre cooldown de 60 s antes da próxima tentativa local; durante
  esse período usa Cloud, preservando token/cliente. Apenas operações idempotentes
  da lâmpada podem usar fallback; toggles não são repetidos.
- Comandos de outros dispositivos Tuya usam outro worker da mesma abstração:
  a listagem Cloud não bloqueia a fila interativa da lâmpada. Capabilities de
  liga/desliga são cacheadas; toggle sem estado conhecido é recusado.
- Node serializa a fila **antes** do stdin. Um comando cancelado ainda na fila
  não chega ao Python. Abort/timeout em voo encerra o worker sem replay. Uma ação
  já aceita pelo dispositivo não pode ser desfeita por cancelamento.
- Métricas: `Tuya queue wait`, `Tuya daemon request`, `Tuya device transport` e
  `Light API request`, visíveis no modo debug.
- Estado desejado é `optimistic`, não `confirmed`. Consultar status lê o aparelho
  e nunca confirma o cache otimista. Readback ausente/incompatível é `unknown`.
- Android TV preserva certificado após reset de conexão. Pareamento e comando
  pendente têm resultados separados. `on/off` não enviam Power se o estado é
  desconhecido; comando pendente não gera novo toggle por engano.
- Escrita de pareamento é serializada e atômica. Falha ao salvar é comunicada.
  Volume, mídia, navegação e toggle explícito continuam disponíveis.
- Home Assistant: POST bem-sucedido indica aceitação, não confirmação física.
  Estado `unknown`/`unavailable` não vira sucesso confirmado.

## Compatibilidade e configuração

- `ULTRON_TUYA_CONFIRM_COMMANDS=1`: exige readback síncrono nas alterações da
  lâmpada. Padrão rápido mantém resposta otimista após aceitação.
- `ULTRON_TUYA_SKIP_LOCAL=1`: mantém transporte Cloud explicitamente escolhido.
- `ULTRON_TUYA_TIMEOUT_MS`: deadline total de fila+chamada (padrão 15 s, limitado
  a 500–60000 ms). Timeout não causa replay de mutação.
- `ULTRON_TUYA_LEGACY_PROCESS=1`: fallback explícito ao fluxo anterior por processo.
  Os CLIs Python existentes permanecem disponíveis.
- Credenciais e pareamentos permanecem nos arquivos locais ignorados. Nenhuma
  nova credencial, dependência ou atualização de pacote foi necessária.

## Testado

- 7 testes TS do cliente: reutilização, serialização, cancelamento na fila/em voo,
  timeout, EPIPE, shutdown e eventos de processo antigo.
- 16 testes Android TV com remote fake e 9 de mensagens/ActionStatus.
- 9 testes Python: socket/identificação reutilizados, readback não inventado,
  cooldown, cache de capabilities, argumentos, toggle desconhecido e redação.
- Smoke do worker real: `ready` e saída limpa com stdin vazio, sem rede/dispositivo.
- TypeScript e `py_compile` aprovados no bloco de transporte.
- Fechamento integrado: `npm test` recompilou o projeto e aprovou 320 testes TS
  no workspace; a seleção de regressão P3 aprovou 71 testes, além dos 9 Python.

## Benchmark e pendências

Antes: processo+probe+identificação por comando local; primeiro fallback Cloud
era outro processo. Depois: o teste de duas ações usa **1 processo / 1 conexão /
1 identificação**, sem consulta de estado extra no fast path.

Isso mede reutilização no harness, não latência física da lâmpada. Ainda faltam
medições reais de API/LAN e validação dos controles na TV do usuário. O cliente
Cloud da versão instalada não expõe Session/timeout HTTP injetável; o token é
reutilizado e Node limita bloqueios encerrando o worker. Não houve monkey-patch
nem mudança no código de terceiros.

Inventário, identificação estável e stale-while-revalidate são detalhados em
`P3_HOME_DISCOVERY.md`. Próximo bloco: índices persistentes e singleton/IPC/CLI.
