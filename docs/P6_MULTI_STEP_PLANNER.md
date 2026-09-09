# P6B — Planner multi-step limitado

## Implementado

- Um executor de planos acíclicos e limitados centraliza a ordem das tools.
  Etapas independentes começam em paralelo; uma falha bloqueia apenas as etapas
  que dependem dela. O kernel aceita no máximo 12 etapas e rejeita IDs duplicados,
  dependências futuras e planos inválidos antes de executar qualquer ação.
- O Fast Router continua sendo a primeira opção. Pedidos determinísticos com
  várias ações usam o mesmo executor e preservam a serialização por recurso. Se
  apenas parte de um pedido composto for reconhecida, nenhuma metade é executada:
  o texto completo segue para o caminho semântico.
- O caminho Ollama agora limita a oito tool calls e três rodadas. Toda tool precisa
  ter sido oferecida naquela rodada, e chamadas repetidas com os mesmos argumentos
  são interrompidas.
- A primeira composição semântica suportada é `email → tarefa` e
  `email → evento`. A política libera somente leitura do Gmail até que um
  `mail.read` ou `mail.thread` tenha sucesso. Depois disso, libera apenas o
  objetivo explicitamente pedido em `task.create` ou `calendar.create`.
- A busca inicial inequívoca de email é roteada localmente. Assim, um pedido como
  “veja o email do processo seletivo e coloque a entrevista na agenda” normalmente
  usa a LLM para escolher o email a ler e para montar o evento, mas não para decidir
  que primeiro precisa pesquisar o email.
- `calendar.create` continua responsável pela verificação de conflito já existente
  no provider; o planner não executa uma consulta de conflito redundante em
  paralelo com a criação.
- Requisições não-streaming do Ollama agora recebem `AbortSignal`, deadline de
  60 segundos e cancelamento pelo mesmo `abortCurrentResponse()` usado no
  barge-in. Interromper uma resposta também interrompe seleção, interpretação e
  rodadas do planner ainda em andamento.
- Logs de debug mostram bootstrap, rodada, tools liberadas, dependências,
  `requestId`, `conversationId` e `toolCallId`. As métricas incluem construção do
  plano, bootstrap local, cada rodada da LLM e cada execução de tool.

## Limites de autorização

As permissões de uma rodada são calculadas somente a partir do pedido original.
Texto vindo de email, tarefa, calendário, arquivo ou nota continua sendo dado não
confiável: ele pode preencher o objetivo solicitado, mas não pode acrescentar uma
tool. Por exemplo, um email que peça para usar `mail.send` não torna essa tool
disponível.

O planner também não guarda conteúdo externo derivado no histórico usado por
futuros planos. Confirmação e capabilities continuam centralizadas no
`ToolRegistry`; o planner não contém um segundo mecanismo de autorização.

## Fluxos

```text
pedido determinístico
  → Fast Router
  → plano local
  → tools independentes em paralelo
  → resposta estruturada

pedido email → tarefa/evento
  → política derivada do texto original
  → busca localmente roteada
  → leitura do email
  → extração semântica limitada
  → task.create ou calendar.create
  → resposta estruturada
```

## Benchmark e validação

O benchmark focado executou 500 planos de quatro etapas sem I/O em cerca de
0,049–0,063 ms por plano. Sob instrumentação de cobertura, a medição final ficou
em 0,110 ms por plano. O custo do kernel é, portanto, desprezível perto de rede,
provider ou inferência; esses valores não medem o Ollama nem serviços reais.

- TypeScript/build aprovados.
- 458/458 testes TypeScript aprovados.
- Cobertura dos módulos carregados: 78,71% de linhas, 77,49% de branches e
  81,03% de funções.
- Testes com doubles cobrem paralelismo, bloqueio de descendentes, resultado
  otimista, limites, cancelamento, bootstrap local, prompt injection, tool não
  autorizada, pergunta por dados ausentes e composição com ramo residencial.
- Nenhuma conta, lâmpada, televisão, microfone, vault real ou instância real do
  Ollama foi acionada durante a validação.

## Pendente

- O planner semântico é deliberadamente limitado a composições de email com
  Tasks/Calendar; ele ainda não é um agente autônomo genérico.
- Uma etapa dependente de uma ação que pediu confirmação não é retomada
  automaticamente após a confirmação em outro turno. A ação confirmada funciona,
  mas a continuação do plano precisa ser pedida novamente.
- Latência física de Gmail/Google Tasks/Calendar e inferência real ainda precisa
  ser medida na instalação configurada.
- Providers adicionais dependem da escolha do serviço e de credenciais do usuário.

## Próxima etapa

P6C: ampliar providers de forma opt-in e evoluir automações compostas persistentes,
reutilizando o Automation Engine, o scheduler e a política central existentes.
