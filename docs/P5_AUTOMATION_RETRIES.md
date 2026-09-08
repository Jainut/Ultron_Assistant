# P5 — repetição segura de automações

## Problema corrigido

O scheduler repetia o job inteiro após falha, recuperava todo `running` como
`retrying` e, no shutdown, recolocava a ocorrência em seu `nextRun` antigo.
Assim, uma resposta perdida após enviar um email, criar uma tarefa ou acionar
um toggle podia provocar a mesma ação novamente. Uma falha na segunda action
também podia repetir uma primeira action já concluída.

Além disso, `AutomationEngine.start()` gerava outro `system.startup` após um
`stop()/start()` do supervisor, mesmo usando a mesma instância do engine.

## Extensão compatível

`SchedulerOptions` e `AutomationEngineOptions` aceitam a opção **opcional**:

```ts
canRetryJob(job, { reason, error }): boolean
```

`reason` distingue `failure`, `recovery`, `shutdown` e `pending-retry`.
Sem essa opção, o uso genérico do scheduler mantém a política de retry anterior.
O runtime real do Ultron passa `canRetryAutomationJob`, que autoriza apenas
ações explicitamente revisadas. Uma exceção na própria policy recusa o replay.

`awaitInitialTick` também é opcional e mantém `true` como padrão para preservar
o contrato genérico de `start()`. O runtime usa `false`: espera recuperação e
registro dos jobs, mas executa o primeiro tick em background, observado e
cancelável. Assim uma tool legítima com duração superior aos 15 s do startup
não provoca falsos reinícios do agendador. O próximo poll só é agendado depois
de o tick anterior drenar; `stop()` continua cancelando e aguardando essa fila.

Não houve troca de registry, handlers, formato principal dos jobs ou stack.
As confirmações existentes continuam sendo exigidas pelas tools: autorizar
retry não concede permissões novas para executá-las.

## Política do runtime

- Consultas conhecidas de horário, arquivos, email, tarefas, calendário e
  notificações podem repetir. Só `status` é autorizado nas tools de controle
  residencial; setters, power, toggle e teclas não ganham retry de job.
- `mail.watch` exige `watchId` persistido; o monitor usa a identidade do email
  para deduplicar notificações. `calendar.reminderScan` usa identificação
  persistida do monitor e dedupe por calendário/evento/início/antecedência.
  O estado e o `NotificationCenter` existentes são reutilizados.
- `personal.dailyBriefing` sem publicação é leitura. Com publicação, só pode
  repetir quando o job contém `at` absoluto, com timezone/offset, que mantém o
  dia da chave de dedupe estável. Sem `at`, uma tentativa após a virada do dia
  poderia gerar outra notificação, então essa ocorrência não é reenviada.
- Email enviado, rascunho, tarefa/evento criado ou alterado, programas abertos,
  mudança contextual de pasta e actions desconhecidas não têm autorização de
  replay. Uma categoria/capability chamada `read` não basta: algumas tools
  antigas de filesystem também abrem aplicativos ou mudam o diretório atual.
- A decisão é sobre **todas** as actions do job. Uma única action sem garantia
  de repetição segura bloqueia a repetição do batch inteiro, inclusive quando
  uma action posterior foi a que falhou.

O briefing, os monitores e as ações mutantes continuam disponíveis para a
primeira execução e para próximas ocorrências autorizadas. A mudança limita
repetições incertas; não remove essas funcionalidades. Novas actions precisam
ser revisadas antes de entrar na allowlist, com evidência de leitura ou dedupe
persistente adequado à repetição de todo o job.

## Falha de uma ocorrência não elimina a recorrência

Uma ocorrência sem replay seguro fica `failed`, com `nextRun: null`, se for
`once`, manual ou um evento não recorrente. Para `interval` e `daily`, o mesmo
job avança para a próxima ocorrência estritamente futura, sem repetir horários
perdidos. O histórico da falha fica preservado até a execução seguinte, que
recebe seu próprio orçamento normal de retry.

`lastError` ganha campos opcionais, compatíveis com registros antigos:

```json
{
  "retryable": false,
  "outcome": "unknown",
  "retrySuppressed": true
}
```

A mensagem explica que o efeito externo pode já ter ocorrido. `failed` aqui
não significa “o email não saiu” nem “o aparelho não mudou”: significa que não
foi possível concluir a execução com certeza e o replay foi recusado. O Ultron
não tenta desfazer efeitos externos. É necessário verificar o destino antes
de solicitar manualmente uma nova ação potencialmente duplicada.

Jobs `retrying` de versões anteriores também passam pela policy antes de
executar. O padrão legado de shutdown (`scheduled`, com tentativa anterior e
`nextRun <= lastRunAt`) é reconhecido como replay, não como nova ocorrência.
O cancelamento explícito do usuário continua terminal, inclusive em jobs
recorrentes; cancelar não é confirmação de que nenhum efeito chegou ao destino.

## Recovery, shutdown e startup

- Recovery não modifica jobs ainda pertencentes a executores ativos e revalida
  o estado/runId dentro da atualização serializada da store.
- O claim de execução é uma atualização atômica condicionada ao estado atual,
  não uma sobrescrita baseada no snapshot anterior. A reserva entra no mapa de
  execução antes de aguardar armazenamento. Cancelar antes/durante o claim não
  pode ser desfeito por um `put(running)` atrasado, nem iniciar uma action depois
  que o cancelamento já foi aceito.
- O shutdown aborta a execução e o tick, aguardando também claims/commits de
  `running` que ainda não chegaram ao mapa de executores ativos. Um executor
  atrasado verifica o signal antes de iniciar. Stop/start concorrentes são
  serializados tanto no engine quanto no scheduler.
- Um handler que não respeita `AbortSignal` continua precisando terminar para
  o shutdown drenar a execução. Não há promessa de desfazer ou matar efeitos
  remotos, nem replay como forma de “resolver” uma ação pendente.
- Uma instância de `AutomationEngine` mantém um único evento `system.startup`.
  Reiniciá-la internamente não cria outro. Se persistir o dispatch parcialmente
  e falhar, a próxima tentativa reutiliza o mesmo evento e não duplica jobs já
  concluídos para ele. Uma nova instância, representando uma inicialização real
  do aplicativo, mantém o comportamento de gerar seu evento de startup.

Essas garantias dependem do uso do runtime protegido e da instância única do
aplicativo. Não implementam transação distribuída nem execução exatamente uma
vez em serviços externos. A integração de singleton/supervisão é complementar.

## Validação offline

Na raiz:

```powershell
npm.cmd run check --prefix apps/core
```

Em `apps/core`:

```powershell
node --import tsx --test tests/automation-engine.test.ts tests/automation-retry-safety.test.ts tests/personal-automation-runtime.test.ts tests/personal-automation-monitors.test.ts tests/daily-briefing.test.ts
```

24 novos testes cobrem allowlist, dedupe, resultado incerto persistido, batch
parcial, leituras com backoff, recorrência, recuperação, jobs legados, shutdown,
cancelamento explícito, commit em voo, policy defeituosa e reinícios/dispatch
parcial, startup independente da duração das tools, compatibilidade do primeiro
tick, erro observado em background e cancelamento entre snapshot/claim. Os
testes anteriores de engine, briefing e monitores permanecem.
São usados handlers falsos e diretórios temporários próprios; nenhum email,
tarefa, evento ou comando residencial real é enviado nessa validação.
