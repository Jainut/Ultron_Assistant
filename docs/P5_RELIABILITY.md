# P5 — Robustez e recuperação incremental

## Implementado

- Supervisor de STT, TTS, workers Tuya e automações, com orçamento de reinícios,
  backoff, health checks e encerramento limitado. Ollama e providers Google têm
  probes de leitura; o Ultron não reinicia instalações externas nem repete tools.
- Entrada no terminal e IPC disponíveis durante o carregamento da voz. Falhas
  de requisição/STT/TTS ficam isoladas; respostas por texto continuam disponíveis.
- Serviços de fundo entram após a voz ou após 10 segundos de tolerância, para
  que um microfone indisponível não impeça todas as automações de iniciar.
- Captura recuperada restaura a referência acústica antes de ouvir durante o
  playback; a fila e o modelo/voz/pitch existentes continuam no mesmo pipeline.
- Estado real dos serviços no HUD azul e resumo em `ultron status`. Um worker
  saudável não comprova que a lâmpada ou televisão esteja ligada.
- Google APIs com deadline total (15 segundos por padrão), cancelamento de
  OAuth/transporte/body e retry limitado apenas para GET. Respostas tardias não
  iniciam uma mutação após cancelamento. `ULTRON_PROVIDER_TIMEOUT_MS` aceita
  ajuste até 60 segundos. A renovação única após HTTP 401 foi preservada.
- Jobs mutantes de resultado incerto não são repetidos em failure/recovery/
  shutdown. A próxima ocorrência recorrente permanece. Cancelar entre seleção
  e claim não permite que uma gravação atrasada volte a executar a action.
- Startup do scheduler não espera concluir tools da primeira rodada no runtime;
  `awaitInitialTick` permanece `true` por padrão para preservar os outros callers.
- GitHub Actions, ESLint, Prettier opcional, checagem UTF-8 e relatório LCOV.

## Alterado

Integração em `apps/core/src/index.ts` e novos adaptadores em `src/system/`;
ciclos de vida em `src/speech/`; workers em `src/automation/`; política e
claims em `src/automation-engine/`; transporte Google; HUD e seus testes.

Detalhes: [supervisão e voz](P5_SUPERVISION.md),
[automações/retries](P5_AUTOMATION_RETRIES.md), [HUD](HUD_NEURAL_BLUE.md).

Somente ferramentas de desenvolvimento foram adicionadas: ESLint, `@eslint/js`
e `typescript-eslint` para análise estática do TypeScript/JavaScript, e Prettier
para formatação optativa. Nenhuma dependência de runtime ou modelo foi trocada.
Não houve reformatação geral do projeto para satisfazer preferências de estilo.

## Testado em 2026-09-08

- `npm run test:coverage`: build TypeScript e **424/424 testes** aprovados.
- Python: **18/18** testes de STT/endpoint/eco, **5/5** de playback/protocolo
  Kokoro e **9/9** de Tuya, usando fixtures sem microfone/modelo/aparelhos reais.
- ESLint: **zero erros**, cinco avisos existentes de atribuição/`prefer-const`.
- CLI compilado: `--help` funciona e `status` informa honestamente ausência de
  instância. Não foi iniciada uma sessão real de microfone/rotinas do usuário.
- HUD revisado em desktop 1280×720 e celular 390×844, sem overflow horizontal;
  botão de desempenho alterna o limite visual de 30 para 18 FPS.
- Cobertura V8 dos módulos carregados: **76,09% linhas**, **76,66% branches**,
  **79,75% funções**. `coverage/core.lcov` fica local e é publicado como artefato
  de CI; não contém logs, credenciais ou notas. Módulos não carregados nos testes,
  inclusive o loop real com hardware, não entram nesse percentual.

O workflow foi configurado para Windows/Node 24. A validação local não comprova
que uma execução futura no GitHub Actions já passou. `format:check` é opcional;
não foi usado como gate nem houve alteração em massa do estilo antigo.

## Benchmark e limites

Antes, a inicialização esperava STT/TTS e uma falha podia encerrar o core. Depois,
o teste com voz intencionalmente travada recebe um comando de terminal e inicia
o scheduler sem esperar a voz. O teste de uma primeira tool além do deadline de
startup mantém o serviço `ready`, uma execução e zero reinícios. São provas de
comportamento com doubles, não medições de latência física.

Não há um novo benchmark físico antes/depois de voz ou de rede nesta etapa.
Permanecem necessários testes de uso contínuo, microfone/alto-falantes, CPU/RAM e
resposta da lâmpada/TV na instalação real. Nenhuma meta de 500 ms/1 s é anunciada
como atingida sem essa medição. O shutdown limita a espera, mas não desfaz uma
ação que um serviço externo já tenha recebido.

## Próxima etapa

P6 começa por Obsidian somente leitura: vault opt-in, Markdown, índice
incremental, títulos, tags, properties, links/backlinks e busca lexical.
Conteúdo de notas é dado não confiável; nunca vira autorização para executar
tools. Embeddings e escrita no vault ficam para fases posteriores.
