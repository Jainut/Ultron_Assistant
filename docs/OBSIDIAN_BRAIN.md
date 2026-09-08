# Cérebro opcional com Obsidian

É viável usar um vault do Obsidian como memória de longo prazo do Ultron sem
transformar o Obsidian em dependência do caminho crítico de voz. O vault é um
conjunto de arquivos Markdown; o Ultron pode indexá-los mesmo com o aplicativo
fechado e preservar links `[[wiki]]`, tags e frontmatter.

## Implementado: primeira fase somente leitura

1. O usuário informa `ULTRON_OBSIDIAN_VAULT`.
2. Um indexador em background consulta apenas arquivos `.md` e mantém metadados,
   títulos, tags, links e trechos em um índice local ignorado pelo Git.
3. Comandos de apps, dispositivos e voz continuam independentes do vault.
4. `memory.search`, `memory.read`, `memory.connections` e `memory.status` usam
   o mesmo ToolRegistry/Fast Router, sem depender da LLM. `memory.summarize`
   entrega a nota ao Ollama sem oferecer ferramentas nessa chamada.
5. Nenhuma escrita, criação, movimentação ou abertura de caminhos vindos das
   properties está implementada. Conteúdo das notas nunca autoriza ações.

Em `ultron.env.cmd`, configure `set "ULTRON_OBSIDIAN_VAULT=C:\caminho\do\vault"`
com um caminho real e reinicie o Ultron. O exemplo acima é somente ilustrativo.
Sem configuração, o módulo permanece desativado e não procura vaults no disco.
Não altere as outras variáveis de voz do arquivo.

Comandos disponíveis:

```text
procure nas minhas notas sobre TypeScript
procure no obsidian #projetos
leia a nota Projetos/Ultron.md
resuma essa nota
mostra as conexões dessa nota
status do obsidian
```

Uma busca com um único resultado guarda apenas a referência estruturada à nota
por dez minutos, isolada por conversa. Múltiplos resultados não escolhem uma
nota automaticamente. Títulos duplicados exigem o caminho relativo, sem
inventar um destino. Durante leitura em voz alta de notas, a primeira fala que
interrompe serve só para parar; repita o comando para evitar executar eco.

O índice atualiza a cada dois minutos, reutiliza o conteúdo de arquivos intactos
e verifica candidatos antes de retornar resultados. Leitura de uma nota sempre
relê esse arquivo. Alterações podem ficar fora da busca até o próximo refresh.
No primeiro carregamento, consultas esperam no máximo cerca de um segundo pelo
índice; depois informam que ele ainda está carregando. Cada consulta tem orçamento
global de cinco segundos e cancelamento; resumo HTTP tem limite de 45 segundos.

Limites: 5.000 notas, 256 KiB por arquivo, 16 MiB de conteúdo, profundidade 16,
50 resultados por lado do grafo. Atingir limites ou falhas de leitura produz
estado parcial. Diretórios ocultos, `.obsidian`, `node_modules`, `dist`, `build`,
symlinks e junctions internas não são seguidos. Markdown UTF-8, links wiki e
links Markdown `.md` são suportados; não é um interpretador de plugins/Dataview.
Properties YAML planas (escalares/listas), tags e aliases são suportados;
properties aninhadas são ignoradas. YAML inválido preserva o corpo legível.

O cache `data/indexes/obsidian.json` contém Markdown privado, não é criptografado,
é ignorado pelo Git e precisa ficar fora do vault (inclusive por junction).
Nenhuma nota é enviada a outro provider; resumo usa o Ollama já configurado.
O uso de um servidor Ollama remoto, se configurado futuramente, exigiria rever
essa fronteira de privacidade. Não há embeddings nesta fase.

## Estrutura sugerida do vault

```text
Ultron/
├── Pessoas/
├── Projetos/
├── Casa/
│   └── Dispositivos.md
├── Preferências/
├── Diário/
└── Inbox Ultron/
```

Uma nota pode usar propriedades simples:

```yaml
---
type: project
aliases: [Fakeboxd]
path: C:\Users\henri\Documents\Fakeboxd
status: active
---
```

Relações como `[[Fakeboxd]] -> [[Backend]] -> [[Supabase]]` podem ser consultadas
como dados. A property `path` acima NÃO é utilizada para abrir o projeto nem
conceder acesso ao sistema. Abertura continua pelas ferramentas de filesystem
existentes, a partir do comando explícito do usuário.

## Fases seguras

- Fase 1 implementada: indexação e consulta somente de leitura.
- Fases futuras, não implementadas: criação de notas na `Inbox Ultron`,
  atualização de properties com confirmação/backup, busca semântica opcional.

O índice inicia junto dos serviços de background, depois da prioridade de voz,
sem bloquear o CMD. A infraestrutura de cache e o ToolRegistry existentes foram
reutilizados. Testes e benchmark: [P6A](P6_OBSIDIAN_READ_ONLY.md).
