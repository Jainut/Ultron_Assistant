# HUD — rede neural azul

## Implementado

- Canvas 2D com projeção de esfera 3D azul/ciano, 420 nós, arestas
  pré-calculadas, órbitas e pulsos. Sem biblioteca gráfica nova.
- Estado, transcrição, resposta e streaming mantêm os mesmos contratos SSE.
- Telemetria usa somente `timings` reais: fim da fala até ação, transcrição,
  intenção, tool e primeira voz. Ausência de medição aparece como `—`.
- Modo desempenho reduz para 230 nós, DPR 1 e máximo 18 FPS. Normal limita a
  30 FPS; custo de desenho elevado ativa redução automática.
- Aba oculta/fora da viewport para animação; `prefers-reduced-motion` produz
  desenho estático. Preferência do botão é local e opcional.
- Servidor agrupa atualizações em 40 ms e respeita backpressure do SSE: um
  cliente lento recebe o snapshot mais recente, não todos os tokens antigos.
- Removido CORS irrestrito; páginas de outras origens não podem ler transcrições
  pelo SSE. A API continua restrita a loopback.
- Painel de saúde recebe os serviços supervisionados, sem inferir disponibilidade
  pela configuração. Conexão perdida e backend sem saúde não aparecem como prontos.

## Validação

- TypeScript, sintaxe JavaScript, 8 testes do servidor e 17 testes de UI.
- Revisão visual da esfera no navegador: desktop 1280×720 e tela estreita 390×844;
  reconexão/estado visível, esfera desenhada e botão econômico funcional.
- Testes cobrem SSE inválido, coalescência, retomada de aba, ausência de internet,
  armazenamento bloqueado, movimento reduzido e limites do grafo/DPR. Também
  cobrem saúde opcional/malformada, descarte de snapshots de conexões antigas,
  proteção de Host, URL inválida e ausência de erros privados na resposta HTTP.

## Saúde dos serviços (P5)

`HudSnapshot.services` é um campo opcional de `PublicServiceHealth[]`. Cada item
contém somente `name`, `state`, `attempts` e `restarts`. O produtor envia
`publicServiceHealth(supervisor.snapshots())`; a borda HTTP também copia apenas
esses quatro campos e descarta serviços/estados desconhecidos. Não publica
`lastFailure`, caminhos, tokens ou respostas de provedores.

O painel inclui Whisper, Kokoro, Ollama, Tuya local/casa, rotinas, Gmail, Tarefas
e Agenda. Estados: iniciando, pronto, limitado, reiniciando, indisponível e
parado. Tentativas e reinícios aparecem no título da linha. Ausência ou dado
inválido mostra **Sem dados**. Perda de SSE limpa a saúde anterior e mostra
**Sem conexão**, inclusive se havia um frame pronto aguardando renderização.
Uma atualização parcial de conversa/métrica não apaga saúde válida da mesma
conexão. O backend antigo continua compatível, sem simular serviços prontos.

Saúde do worker/serviço não equivale ao estado físico da lâmpada ou da TV.
TV e Home Assistant continuam suportados pelas tools existentes, mas este
painel não afirma monitorá-los. Não há nova sondagem ou comando de dispositivo
disparado pelo HUD.

## Proteção da interface local

- Aceita `Host` somente `127.0.0.1:porta` ou `localhost:porta`, na porta real do
  HUD (incluindo fallback). Host externo é recusado mesmo sem `Origin`.
- Se presente, `Origin` deve corresponder exatamente à origem local do Host.
  Isso bloqueia o caso de DNS rebinding que o vínculo a loopback sozinho não cobre.
- URL malformada retorna 400; origem externa/credenciais no request-target são
  recusadas com 403. Nenhuma dessas entradas derruba o servidor.
- Status e SSE usam `Cache-Control: no-store` e `nosniff`. Não há CORS permissivo.

Isso protege a fronteira do navegador; não é autenticação contra processos
locais que já podem conectar à porta loopback. O HUD permanece somente leitura.

## Benchmark e limites

Antes o servidor transmitia um snapshot por token; agora uma rajada de 100
updates no teste gera uma publicação final na janela de 40 ms. Isso é medição
do protocolo, não de latência física de voz. Falta comparar carga de CPU/GPU
com Whisper/Ollama/Kokoro ativos na máquina do usuário.

O preview (`npm --prefix apps/core run hud`) é apenas visual, sem microfone ou
tools. Como não inicia o supervisor, seus indicadores mostram **Sem dados**.
A disponibilidade física dos dispositivos continua dependendo da integração
correspondente, não do desenho da esfera nem da abertura do painel.
