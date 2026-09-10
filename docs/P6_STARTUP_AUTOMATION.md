# P6C — Automação composta de inicialização

## Implementado

- A tool `automation.createStartupBriefing` transforma pedidos como “quando eu
  ligar o computador, veja se chegou algum email importante” em uma automação
  persistida `system.startup → personal.dailyBriefing`.
- A composição reutiliza integralmente o Automation Engine, o scheduler, o
  ActionRunner, a persistência, os retries e o Notification Center existentes.
  Não existe um scheduler paralelo nem um caminho privilegiado para providers.
- Criações equivalentes são idempotentes, inclusive quando chegam ao mesmo tempo.
  A ordem informada de `calendar`, `tasks` e `mail` é normalizada antes de gerar o
  fingerprint persistido.
- O Daily Briefing agora aceita uma lista explícita de fontes. Consultas não
  solicitadas nem chegam ao provider: uma verificação só de Gmail não aguarda
  Google Calendar ou Tasks.
- Briefings diários existentes continuam consultando as três fontes quando o
  campo novo é omitido. Automações antigas, que não possuem `sources`, continuam
  sendo reconhecidas com essa mesma semântica.
- Respostas e notificações enumeram apenas as fontes pedidas. Texto externo não é
  copiado para a notificação; somente contagens saneadas são publicadas.
- `maxEmails` só participa da configuração, da action e da idempotência quando
  email faz parte das fontes. Alterar esse parâmetro em um resumo apenas de agenda
  e tarefas não cria uma automação duplicada.
- O parser pt-BR reconhece inicialização do computador, Windows ou Ultron e mantém
  o monitor “quando chegar um email…” separado do gatilho de startup.

## Fluxo

```text
fala ou CMD
  → Personal Intent Parser (local, sem LLM)
  → automation.createStartupBriefing
  → AutomationStore
  → próxima inicialização real do Automation Engine
  → personal.dailyBriefing(fontes escolhidas)
  → providers solicitados em paralelo
  → Notification Center
```

Exemplos reconhecidos:

```text
quando eu ligar o computador, veja se chegou algum email importante
ao iniciar o Windows, mostre minha agenda, tarefas e emails
na inicialização, confira minhas tarefas
```

## Compatibilidade e segurança

- A configuração de conta continua explícita. Sem provider pessoal configurado,
  a criação falha com `PROVIDER_NOT_CONFIGURED` e não persiste uma automação
  quebrada.
- A tool apenas lê as fontes selecionadas e publica contagens. Ela não envia
  email, altera evento ou conclui tarefa.
- Conteúdo recebido continua marcado como não confiável e nunca pode ampliar as
  capabilities da automação.
- O evento `system.startup` é emitido uma vez por instância real do Automation
  Engine. Reinício interno do supervisor na mesma instância não dispara o evento
  de novo, preservando a proteção contra duplicidade já existente.
- O atraso configurável é limitado a 0–300 segundos e o limite de emails a
  1–100. Timezones passam pela validação IANA existente.

## Validação

- TypeScript e build aprovados.
- 465/465 testes TypeScript aprovados.
- Cobertura dos módulos carregados: 78,97% de linhas, 77,71% de branches e
  81,10% de funções.
- Testes locais cobrem execução real do trigger, persistência, seleção de fontes,
  idempotência concorrente, normalização, provider ausente, validação e roteamento
  de linguagem natural.
- Nenhuma conta, provider remoto, lâmpada, televisão, microfone ou modelo real foi
  acionado durante a validação.

## Limites

- “Ao ligar o computador” significa a próxima inicialização do processo do
  Ultron. Para ocorrer no boot do Windows, o próprio Ultron precisa estar
  configurado para iniciar com a sessão; esta etapa não fez essa alteração de
  sistema operacional silenciosamente.
- O resumo publica contagens, não assunto ou corpo de emails, para preservar
  privacidade e impedir prompt injection em automações sem supervisão.
- Providers adicionais continuam dependendo da escolha do serviço e das
  credenciais que o usuário pretende conectar. Nenhum provider foi presumido.

## Continuação

A P6D adicionou Microsoft To Do e Outlook Calendar de forma opt-in, preservando
as interfaces `TaskProvider` e `CalendarProvider`. A composição por domínio e os
limites estão documentados em [P6_MICROSOFT_PROVIDERS.md](P6_MICROSOFT_PROVIDERS.md).
