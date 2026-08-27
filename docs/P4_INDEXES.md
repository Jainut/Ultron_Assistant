# P4 — índices persistentes de aplicativos e arquivos

## Compatibilidade

`ApplicationResolver.start()/resolve()`, `fileSystem.startIndexing()` e as tools
existentes continuam usando as mesmas APIs. Aliases configurados, argumentos de
inicialização, fuzzy matching, atalhos, Registry/App Paths, Microsoft Store e
fallback `where.exe` foram mantidos. A configuração manual continua tendo
prioridade e pode usar comandos relativos ao PATH, sem validação destrutiva.

Navegação, `currentWorkingDirectory`, última pasta/arquivo, criação sem
sobrescrita e abertura no Explorer/VS Code permanecem no serviço existente.
Os índices não armazenam/restauram o cwd de outra sessão. Uma abertura explícita
no editor com caminho inexistente falha sem substituir o alvo pelo cwd.

## Cache local

- `data/indexes/applications-v1.json`
- `data/indexes/filesystem-v1.json`

Cada arquivo tem `schemaVersion`, assinatura SHA-256 das fontes/roots/regras,
`updatedAt` e payload validado. Fontes diferentes, versão incompatível, JSON
corrompido ou arquivos maiores que 32 MiB são tratados como cache miss. O arquivo
anterior permanece íntegro até a gravação completa, flush e rename de um
temporário único no mesmo diretório. Falha de persistência mantém o índice em
memória e não impede as tools de funcionar.

O cache contém nomes, caminhos, tipos, metadados de diretórios e comandos de apps.
Não lê nem indexa conteúdo de documentos. Esses dados são privados e locais;
`data/indexes/` não deve ser versionado nem enviado ao repositório.

## Resposta e atualização

As consultas carregam o cache antes de aguardar qualquer scan. Um alias manual
continua disponível imediatamente, mesmo sem cache. Somente candidatos a uma
resposta recebem validação de existência; não há `stat` de todo o catálogo no
caminho de um comando. Candidatos removidos são descartados e sua fonte/pasta é
invalidada para atualização.

| Fonte | TTL padrão | Limite de profundidade |
| --- | --- | --- |
| Arquivos/pastas | 15 minutos | 7 níveis |
| Menu Iniciar | 30 minutos | 8 níveis |
| PATH | 30 minutos | sem recursão |
| Registry e Microsoft Store | 30 minutos | consulta específica da fonte |
| Program Files | 24 horas | 4 níveis |
| LocalAppData | 24 horas | 3 níveis |

Uma reinicialização com cache fresco não repete scans de Program Files/AppData,
consultas Registry/Store ou listagens de documentos. Na expiração, o refresh roda
em segundo plano. Diretórios com `mtime` inalterado reutilizam seus snapshots;
somente diretórios alterados são novamente listados. O refresh ainda consulta
metadados dos diretórios conhecidos para detectar mudanças em descendentes.
Não é um watcher em tempo real nem uma varredura integral do disco.

Sem um resultado em cache, a espera pela descoberta é limitada a 300 ms no
filesystem e 650 ms nos aplicativos, além da carga/validação local necessária.
O scan compartilhado pode continuar em background. Um aplicativo recém-instalado
ou arquivo em uma árvore ainda não indexada pode aparecer somente após o refresh;
não há garantia de cobertura imediata de todos os discos.

Buscas durante um segundo refresh aguardam a geração atual do scan rápido;
uma promise resolvida ou cancelada da geração anterior não encerra a busca cedo.

## Limites e cancelamento

- BFS com limites por passagem: até 5.000 diretórios e 10 segundos, profundidade
  limitada e cedência periódica do event loop.
- Catálogo do filesystem limitado a 50.000 entradas; apps descobertos a 30.000,
  preservando separadamente todos os aliases configurados.
- As passagens de apps limitam a inspeção a 15.000 itens no Menu Iniciar,
  30.000 no PATH e 50.000 em Program Files/LocalAppData.
- `node_modules`, `.git`, `.venv` e caches conhecidos são ignorados; o filesystem
  continua ignorando `AppData`. Links/junctions aninhados não são seguidos. Roots
  explicitamente configurados podem ser junctions.
- Listings truncados não são salvos como snapshots completos. Índices parciais
  não apagam em massa resultados anteriores, e seu status é exposto.
- Refresh parcial do filesystem tenta novamente após até 30 segundos; fontes de
  apps incompletas após 5 minutos. Os limites continuam valendo nessas tentativas.
- `AbortSignal` cancela espera, busca, fuzzy ranking, traversal e subprocessos
  `reg.exe`/PowerShell/`where.exe`. Um refresh compartilhado de startup não é
  cancelado por um único consumidor desistir de sua busca.
- `stop()` aborta o ciclo de vida do índice e limpa timers. Operações nativas de
  filesystem já entregues ao Windows podem concluir internamente, mas o resultado
  é ignorado após cancelamento; não há novos passos de traversal nem publicação
  posterior de um cache cancelado.

## APIs adicionais para integração e diagnóstico

```ts
applicationResolver.getIndexStatus();
await applicationResolver.refresh({ force: true, signal });
applicationResolver.stop(); // síncrono

fileSystem.getIndexStatus();
await fileSystem.refreshIndex({ force: true, signal });
fileSystem.stop(); // síncrono
```

Os construtores aceitam opções para roots, caminho do cache, TTL e limites. Isso
permite testes isolados e futuras integrações sem mudar chamadas existentes.
`cachePath: null` desativa persistência. Nenhuma dependência foi adicionada.

## Validação automatizada

```powershell
node --import tsx --test apps/core/tests/persistent-index.test.ts apps/core/tests/persistent-application-index.test.ts apps/core/tests/persistent-filesystem-index.test.ts apps/core/tests/filesystem-service.test.ts apps/core/tests/characterization-local-system.test.ts
npm run check
```

As fixtures usam apenas diretórios temporários, atalhos/executáveis inertes e
Registry/Store desabilitados. Cobrem restart com **zero traversal** para cache
fresco, refresh sem mudança com **zero novas listagens**, atualização de uma
subpasta com **uma única listagem**, invalidação de caminhos removidos, mudança
de roots, limites, cancelamento, cache corrompido, falha de escrita e preservação
de aliases/cwd/criação segura. Nenhum aplicativo ou documento real é aberto.

Esses resultados comprovam o mecanismo de cache em fixtures, não constituem um
benchmark de todos os aplicativos/documentos da máquina do usuário.
