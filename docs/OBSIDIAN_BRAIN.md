# Cérebro opcional com Obsidian

É viável usar um vault do Obsidian como memória de longo prazo do Ultron sem
transformar o Obsidian em dependência do caminho crítico de voz. O vault é um
conjunto de arquivos Markdown; o Ultron pode indexá-los mesmo com o aplicativo
fechado e preservar links `[[wiki]]`, tags e frontmatter.

## Arquitetura recomendada

1. O usuário informa `ULTRON_OBSIDIAN_VAULT`.
2. Um indexador em background observa apenas arquivos `.md` e mantém metadados,
   títulos, tags, links e trechos em um índice local ignorado pelo Git.
3. Consultas determinísticas continuam no Fast Intent Router e nunca esperam o
   vault.
4. Somente perguntas que precisam de memória consultam primeiro o índice por
   título, tag, links e texto; os poucos trechos relevantes entram no contexto
   do Ollama.
5. Escrita começa em modo seguro: criar uma nota nova é permitido, mas editar,
   mover ou sobrescrever uma nota existente exige confirmação.

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

Assim, “abre meu projeto Fakeboxd” pode consultar o índice do vault somente se
a busca rápida de pastas não encontrar um resultado. Relações como
`[[Fakeboxd]] -> [[Backend]] -> [[Supabase]]` ajudam respostas contextuais sem
dar à LLM liberdade para inventar caminhos.

## Fases seguras

- Fase 1: indexação e consulta somente de leitura.
- Fase 2: criação de notas na `Inbox Ultron`.
- Fase 3: atualização de propriedades com confirmação e backup da nota.
- Fase 4: busca semântica opcional com embeddings locais.

Não recomendo colocar embeddings ou leitura completa do vault na inicialização.
O índice deve ser incremental, e conteúdo sensível deve permanecer local. Essa
integração pode ser adicionada depois como uma tool de memória sem alterar STT,
TTS, automação, filesystem ou o router implementado nesta etapa.
