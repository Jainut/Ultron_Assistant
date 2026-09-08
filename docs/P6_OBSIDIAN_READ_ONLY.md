# P6A — Obsidian somente leitura

## Implementado

- Indexador opt-in de Markdown, reutilizando o cache atômico e os snapshots de
  diretórios da P4. Sem serviço Python novo, sem scan de todo o disco.
- Properties YAML planas, aliases, títulos, tags, links/backlinks e busca lexical
  com títulos priorizados. Releitura somente dos arquivos alterados no refresh.
- Cinco tools na registry existente, com capability `memory.read`, schema,
  contexto por conversa, resultados não confiáveis e métricas de tool existentes.
- Fast Router para busca/leitura/grafo/status. Resumo usa uma única interpretação
  da LLM, sem tools disponíveis e sem guardar dados derivados no histórico de
  planejamento. Transporte dessa interpretação agora propaga abort e tem deadline.
- Proteção de playback externo reaproveitada: eco de leitura não vira comando.
  Barge-in interrompe a nota; a primeira transcrição é descartada, peça novamente.
- Configuração e inicialização opcionais em background. Nenhuma alteração no
  modelo Whisper, Kokoro, pitch, SpeechQueue/Chunker, Tuya, Android TV ou HUD.

## Arquivos principais

- `apps/core/src/memory/`: parser Markdown/properties, índice e runtime opcional.
- `apps/core/src/tools/memory/obsidian.tools.ts`: contrato/execução das cinco tools.
- `apps/core/src/intent/memory-intent-parser.ts`: comandos explícitos locais.
- Integrações localizadas em `core-tool-registry.ts`, `fast-intent-router.ts`,
  `ollama.service.ts`, `index.ts`, `tool.ts` e `ultron.env.example.cmd`.
- `obsidian-index.test.ts` e `obsidian-tools.test.ts`: fixtures isoladas.

## Dependência

Adicionado `yaml@2.9.0`, sem dependências transitivas, para ler YAML de properties
com um parser existente. Não houve upgrade das dependências anteriores. Custom
tags/aliases expansivos são recusados; YAML não executa código, templates ou
plugins. Strings de properties são saneadas também após decodificação YAML.

Semântica consultada nas fontes primárias: [properties](https://obsidian.md/help/properties),
[links](https://obsidian.md/help/links), [tags](https://obsidian.md/help/tags) e
[parser YAML](https://eemeli.org/yaml/). Não se pretende reproduzir todos os plugins
ou todas as variantes de Markdown do Obsidian.

## Benchmark

Fixture local de 500 notas de aproximadamente 1,2 KiB cada; execução focada,
sem microfone, modelo ou rede:

| Operação | Tempo observado | Arquivos Markdown relidos |
| --- | ---: | ---: |
| Refresh inicial | 859 ms | 500 |
| Refresh com cache quente | 216 ms | 0 |
| Busca lexical quente, cinco resultados | 13 ms | 0 |

É comparação de cache frio/quente, não de versão antiga/nova: não havia índice
Obsidian implementado antes. Não mede speech-end → ação/voz e não é garantia para
vaults reais, OneDrive ou discos de rede. O teste verifica reúso, não um limite
temporal frágil em CI.

## Validação e limites

- Build/TypeScript aprovados, 437/437 testes TypeScript aprovados. ESLint mantém
  os cinco avisos prévios, sem erros. Cobertura dos módulos carregados pela suíte:
  77,52% de linhas, 77,04% de branches, 80,22% de funções. Isso não representa
  cobertura dos fluxos físicos nem dos arquivos não carregados pelos testes.
- Fixtures cobrem atualização/remoção, cache entre instâncias, ambiguidade,
  links relativos, junctions, traversal, limites, YAML inválido, cancelamento,
  isolamento de conversa, capability/schema e instruções maliciosas em notas.
- Mock HTTP comprova ausência de tools na interpretação, descarte do conteúdo
  no histórico posterior e cancelamento mesmo com transporte travado.
- Vault real ainda não conectado: depende do caminho informado pelo usuário.
  Nenhuma varredura de notas pessoais, microfone ou automação física foi executada.
- Cache é local e privado, mas não criptografado. Sem escrita no vault e sem
  integração automática das properties com tools de sistema.
- O grafo é consultável como dados; a esfera neural do HUD não foi substituída
  por um navegador visual do vault nesta etapa.

## Próxima etapa

P6B: planner multi-step e automações compostas sobre a registry existente.
Providers adicionais dependem da escolha da integração e das credenciais;
nenhuma conta nova é conectada automaticamente.
