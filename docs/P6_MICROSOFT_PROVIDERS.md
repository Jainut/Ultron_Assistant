# P6D — Microsoft To Do e Outlook Calendar

## Resultado

A etapa adiciona dois adaptadores Microsoft Graph sem substituir os providers
Google existentes:

- `MicrosoftTodoProvider` implementa integralmente `TaskProvider`;
- `MicrosoftCalendarProvider` implementa integralmente `CalendarProvider`;
- `OAuthApiClient` concentra deadline, cancelamento, refresh após `401`, retry
  somente de leitura e bloqueio de URLs fora do provider;
- `google.connect` continua intacta e `microsoft.connect` é a única entrada que
  pode iniciar o login Microsoft;
- construir o runtime, registrar tools e iniciar o Ultron não abre navegador e
  não faz chamada ao Graph.

Não foi adicionada dependência npm. O transporte usa `fetch`, `AbortSignal`, o
cliente OAuth/PKCE e o `SecretStore` DPAPI que já existiam.

## Composição por domínio

O runtime seleciona mail, tarefas e calendário separadamente:

| Configuração | Mail | Tarefas | Calendário |
| --- | --- | --- | --- |
| somente Google | Gmail | Google Tasks | Google Calendar |
| somente Microsoft | indisponível | Microsoft To Do | Outlook Calendar |
| Google + Microsoft | Gmail | Microsoft To Do | Outlook Calendar |

`ULTRON_TASK_PROVIDER` e `ULTRON_CALENDAR_PROVIDER` aceitam `google` ou
`microsoft`. Assim uma instalação existente continua funcionando sem alterar
configuração, e uma instalação híbrida pode escolher os providers gradualmente.

## Cadastro no Microsoft Entra

1. Crie um registro de aplicativo compatível com a conta que será usada.
2. Adicione a plataforma **Mobile and desktop applications** e o redirect URI
   `http://localhost/oauth2/microsoft/callback`.
3. Habilite o aplicativo como cliente público. O fluxo local usa authorization
   code com PKCE; client secret é opcional e não é recomendado para um cliente
   público instalado.
4. Adicione permissões **delegadas** Microsoft Graph `Tasks.ReadWrite` e
   `Calendars.ReadWrite`.
5. Configure o Application (client) ID no arquivo local ignorado pelo Git:

```cmd
set "ULTRON_MICROSOFT_CLIENT_ID=seu-client-id"
set "ULTRON_MICROSOFT_TENANT=common"
set "ULTRON_MICROSOFT_TIME_ZONE=America/Sao_Paulo"
```

Depois de reiniciar o Ultron, diga `conecte minha conta Microsoft`. O scope
`offline_access` é incluído para renovar a sessão sem pedir pareamento em toda
execução. Tokens ficam cifrados pelo DPAPI `CurrentUser` e nunca entram nos logs.

Referências oficiais:

- [Authorization code com PKCE no Microsoft identity platform](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Redirect URIs para aplicações desktop](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url)
- [Permissões do Microsoft Graph](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [Criar tarefa no Microsoft To Do](https://learn.microsoft.com/en-us/graph/api/todotasklist-post-tasks?view=graph-rest-1.0)
- [Calendar view do Outlook](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
- [Criar evento no Outlook](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0)

## Comportamento e segurança

- Lista padrão do To Do é descoberta uma vez e mantida em cache. IDs explícitos
  continuam disponíveis por configuração ou input.
- Tarefas criadas a partir de Gmail recebem um `linkedResource` com deep link;
  metadados são codificados e validados, nunca tratados como instrução.
- Agenda usa `calendarView`, portanto inclui ocorrências de eventos recorrentes.
- Conflitos são verificados antes de criar ou alterar eventos, ignorando itens
  cancelados e horários marcados como livres.
- Excluir tarefa e cancelar evento continuam exigindo confirmação central em um
  turno separado.
- Títulos, notas, locais, participantes e links recebidos do Graph são marcados
  `untrusted`, como já ocorria nos providers Google.
- Paginação só aceita `nextLink` HTTPS dentro de
  `graph.microsoft.com/v1.0`; tokens não podem ser enviados a outra origem.
- Escritas não são repetidas automaticamente quando a resposta é perdida.
- Datas com horário são normalizadas em UTC. Eventos de dia inteiro preservam a
  data civil e são enviados à meia-noite no mesmo fuso, conforme o contrato do
  Graph.

## Limites

- A etapa não cria o app no tenant do usuário nem autentica uma conta real sem
  pedido explícito.
- Microsoft Mail/Outlook Mail ainda não foi adicionado; Gmail permanece o
  provider de email quando configurado.
- Busca de tarefas e eventos é filtrada localmente sobre uma página limitada,
  porque os endpoints usados não oferecem a mesma pesquisa textual do Gmail.
- `parentId` é recusado no adaptador To Do, pois a API v1.0 usada não oferece o
  mesmo contrato de subtarefa do Google Tasks.
- Latência real depende da rede e do tenant. O cliente impõe deadline global e
  propaga barge-in/cancelamento, mas os testes desta etapa não acionam contas
  reais.

## Validação

Os testes usam transportes HTTP simulados. Eles cobrem OAuth/PKCE, scopes,
seleção híbrida de provider, ausência de login no startup, cache da lista padrão,
datas, linked resources, conflitos, confirmações destrutivas, paginação segura,
contexto operacional e comandos determinísticos. Nenhuma conta, dispositivo,
microfone ou modelo real é acionado.

Validação final da árvore completa: **476/476 testes**, cobertura global de
**78,93%** em linhas, **77,27%** em branches e **81,45%** em funções. `tsc`,
UTF-8, build e lint passaram; o lint manteve apenas cinco avisos preexistentes
fora desta etapa.
