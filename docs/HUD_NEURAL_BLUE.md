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

## Validação

- TypeScript, sintaxe JavaScript, 4 testes do servidor e 12 testes de UI.
- Revisão visual no navegador: desktop 1280×720 e tela estreita 390×844;
  reconexão/estado visível, esfera desenhada e botão econômico funcional.
- Testes cobrem SSE inválido, coalescência, retomada de aba, ausência de internet,
  armazenamento bloqueado, movimento reduzido e limites do grafo/DPR.

## Benchmark e limites

Antes o servidor transmitia um snapshot por token; agora uma rajada de 100
updates no teste gera uma publicação final na janela de 40 ms. Isso é medição
do protocolo, não de latência física de voz. Falta comparar carga de CPU/GPU
com Whisper/Ollama/Kokoro ativos na máquina do usuário.

O preview (`npm --prefix apps/core run hud`) é apenas visual, sem microfone ou
tools. Os nomes de integrações indicam suporte existente, não disponibilidade
verificada de cada dispositivo.
