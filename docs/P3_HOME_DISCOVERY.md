# P3 — inventário e descoberta residencial

## Compatibilidade e limites

A descoberta existente continua usando SSDP, mDNS, ARP, sondagens dos protocolos
já suportados e Tuya Cloud. As APIs públicas anteriores permanecem; parâmetros
opcionais permitem cancelamento e testes sem dispositivos. Não foi adicionada
dependência nem substituída a integração existente da lâmpada ou da Android TV.

- Cache encontrado: resposta imediata a partir do inventário, com atualização
  em background quando estiver antigo (stale-while-revalidate).
- Cache ausente: espera de até 1.500 ms por resultados incrementais. Se não
  encontrar nesse orçamento, a descoberta continua em background.
- Scan compartilhado: chamadas concorrentes usam uma única execução; chamadas
  não forçadas têm cooldown de 30 s. A atualização automática continua a cada
  5 min, e um scan tem deadline de 12 s.
- Resultados locais são publicados sem aguardar a descoberta Tuya Cloud.
- Sondagem limitada a 64 IPs, com 6 hosts simultâneos e portas conhecidas em
  paralelo. Não há varredura irrestrita de sub-redes ou de endereços externos.
- Inventário limitado a 1.024 dispositivos e retenção de 30 dias.
- `ULTRON_DISABLE_DISCOVERY=1` continua desabilitando a descoberta automática.

O orçamento de 1.500 ms acomoda as janelas atuais de mDNS (1 s) e SSDP (1,2 s).
Não é uma promessa de descobrir todo aparelho nesse tempo. Dispositivos na
internet podem estar em outra VLAN/rede, sem protocolo local suportado, sem
permissão de controle ou sem responder a esses mecanismos.

## Inventário versionado e identidade

`data/discovered-devices.json` aceita o array legado e passa a persistir o
envelope `{ "version": 2, "devices": [...] }`. A gravação é serializada, usando
arquivo temporário no mesmo diretório e rename. Um arquivo ilegível ou com
schema desconhecido não é sobrescrito: o cache é reconstruído somente em
memória nessa execução.

Campos adicionais são opcionais para consumidores antigos:

| Campo | Significado |
| --- | --- |
| `lastDiscovered` | Última identificação por uma fonte de descoberta. |
| `lastReachable` / `online` | Alcance observado; `online: true` expira após 60 s e vira desconhecido. ARP sozinho não prova alcance. |
| `lastConfirmed` | Último resultado que trouxe `confirmed: true`, não o instante de envio de um comando. |
| `paired` | Pareamento conhecido; `null` quando não foi estabelecido pelo inventário. |
| `controllable` | Evidência histórica de comando aceito ou estado confirmado pelo protocolo, não garantia de controle atual. |
| `capabilities` | Ações implementadas pelo adaptador, modo de power e necessidade de pareamento; não prova autorização no aparelho. |
| `addressConflict` | O IP salvo foi observado com identidade incompatível; comandos para esse endereço ficam bloqueados. |

MAC normalizado, identificador de dispositivo e ID estável são usados para
reconciliar mudanças de IP. MACs, deviceIds ou IDs estáveis incompatíveis não
herdam autorização. O IP sozinho nunca transfere `authToken`; uma resposta de
descoberta também não pode fornecer um token novo ao inventário. Um token
Samsung recebido durante a sessão só é salvo na identidade correspondente ao
snapshot da sessão, não no novo ocupante daquele IP.

LG, Google Cast, UPnP e dispositivos genéricos continuam podendo ser detectados
sem serem apresentados como integração de controle implementada. Pareamentos
Android existentes continuam no armazenamento próprio do serviço Android TV.

## Cancelamento e recuperação de endereço

Sockets TCP/UDP, HTTP e WebSocket recebem o cancelamento apropriado, com
timeouts e limpeza de listeners/timers. Cancelar uma busca deixa de esperar,
sem interromper o scan compartilhado de outras chamadas. Shutdown cancela o
scan e ignora publicações atrasadas; fontes lentas não podem alterar um scan
já encerrado. Respostas SSDP só podem apontar para HTTP(S) no IP privado que
anunciou o serviço, sem redirecionamentos.

Antes de controlar, o endereço mais recente da mesma identidade é consultado
no cache. Após falha de transporte, uma atualização limitada pode procurar
essa identidade em outro IP. A repetição automática acontece no máximo uma
vez e somente para operações idempotentes:

- `status`;
- `on/off` de Roku, Kasa, Shelly, WLED e Tuya.

Não são repetidos toggle, volume relativo, mute, teclas de navegação nem
power Android/Samsung. Um toggle que falhou pode iniciar descoberta para a
próxima solicitação explícita, mas nunca é reenviado automaticamente. Erros de
autorização, protocolo ou argumento não geram tentativa de recuperação por IP.
Cancelar uma ação já recebida pelo aparelho não desfaz seu efeito físico.

## Correções dos adaptadores

- Shelly Gen2 usa `Switch.Toggle` para toggle. Geração descoberta fica no
  inventário; a resolução complementar tem cache de 1 h. O campo `was_on` é o
  estado anterior, portanto a resposta de alteração é apenas `accepted`.
  `Switch.GetStatus.output` pode confirmar o estado observado. Essa distinção
  segue a [documentação oficial do componente Switch](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch/).
- Kasa verifica `err_code` e a estrutura da resposta. Toggle exige
  `relay_state` válido; estado ausente não é tratado como desligado.
- Roku e Samsung não confundem HTTP alcançável/tecla enviada com confirmação
  física de energia. Eventos Samsung tardios ou duplicados não reenviam teclas.
- WLED diferencia leitura de estado e aceitação do POST.
- Tuya mantém o cliente Python persistente integrado pelo bloco de transporte,
  propagando `signal` e preservando os campos de confirmação/otimismo.

Métricas `Device lookup` e `Device command` usam o coletor de performance
existente. Persistir o resultado no inventário não bloqueia a resposta da tool.

## Validação offline

Na raiz do projeto:

```powershell
npm.cmd run check --prefix apps/core
```

Em `apps/core`:

```powershell
node --import tsx --test tests/home-discovery-inventory.test.ts tests/home-discovery-control.test.ts tests/device-discovery.test.ts tests/android-tv-remote.test.ts tests/home-automation-responses.test.ts
```

Os testes usam scanner, HTTP, WebSocket, Kasa, Android TV e Tuya injetados,
incluindo DHCP, conflito de identidade, migração, gravação atômica, cancelamento,
singleflight, resultados incrementais, limites de concorrência, ausência de
replay e respostas de protocolo incompletas. Nenhum scan real, pareamento ou
comando residencial foi executado nesta validação. Latência física e suporte
efetivo dos aparelhos precisam ser medidos em uma sessão autorizada com o
hardware do usuário; os testes não demonstram esses resultados.
