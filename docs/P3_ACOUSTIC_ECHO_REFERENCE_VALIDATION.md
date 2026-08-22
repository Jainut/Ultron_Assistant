# P3 — referência acústica e validação de barge-in

## Escopo e conclusão

Esta etapa adiciona uma referência acústica **conservadora** antes do início do
barge-in. Ela compara cada bloco do microfone com o WAV que o Ultron está
reproduzindo e suprime somente blocos praticamente explicados pelo próprio
playback.

Isso não é um cancelador de eco adaptativo completo: nenhum áudio é subtraído da
gravação e nenhuma decisão da referência pode autorizar comandos. Falha de
carregamento, tempo, alinhamento ou correlação sempre deixa o bloco passar.

Não foi encontrado P0 no contrato atual. Os P1 remanescentes estão documentados
em “Riscos ainda abertos” e precisam de validação em hardware antes de chamar o
recurso de AEC.

## Critérios de segurança

| Cenário | Critério |
|---|---:|
| Eco puro, atraso de 0–250 ms, ganhos variados e ruído | pelo menos 95% dos blocos elegíveis suprimidos |
| Fala diferente sobreposta ao eco | no máximo 5% suprimidos; alvo de 0% |
| Fala sem eco | no máximo 1% suprimido |
| Fim atrasado de uma geração anterior | não pode limpar a geração atual |
| WAV/path/timestamp inválido | fail open, sem supressão |
| Custo por bloco de 50 ms | p95 abaixo de 5 ms |

Os defaults deliberadamente conservadores são:

- atraso pesquisado: 0 a 250 ms, em passos de 5 ms;
- correlação mínima: 0,97;
- razão residual máxima: 0,18;
- RMS mínimo da referência: 0,002;
- idade externa máxima aceita no início: 500 ms;
- tolerância de expiração: 1.500 ms;
- WAV PCM absoluto, até 64 MiB e 120 segundos.

Correlação alta sozinha não é suficiente. A projeção do playback precisa também
explicar quase toda a energia do bloco. Isso evita descartar fala diferente que
ocorra simultaneamente, mesmo quando o playback ainda é dominante.

## Benchmark offline reproduzível

O harness cria um WAV PCM local determinístico a 48 kHz e renderiza:

- ecos com atrasos de 20, 80, 160 e 240 ms;
- ganhos de 0,20, 0,55, 1,10 e -0,55 (polaridade invertida);
- ruído com SNR de 24 dB;
- uma reflexão secundária após 7 ms, com ganho 0,10;
- fala independente sobreposta nas razões near/echo 0,20, 0,35 e 0,70;
- fala independente sem eco;
- referência inválida e término de geração obsoleta.

Execução completa de 22 de agosto de 2026 nesta máquina:

| Resultado | Medido |
|---|---:|
| Cenários de eco puro | 16/16 com 100% de supressão |
| Erro mediano de atraso | 0 ms |
| Cenários de fala sobreposta | 9/9 com 0% de falsa supressão |
| Fala independente | 0% de falsa supressão |
| Geração obsoleta/path inválido | fail safe aprovado |
| Processamento p50 | 1,169 ms/bloco |
| Processamento p95 | 1,929 ms/bloco |
| Máximo observado | 6,954 ms/bloco |

O p95 usa aproximadamente 3,9% do orçamento de um bloco de 50 ms. O máximo é
registrado para diagnóstico, mas não representa o comportamento sustentado.

Para reproduzir:

```powershell
& services/speech-input/.venv/Scripts/python.exe `
  scripts/audio/benchmark_playback_echo_reference.py

& services/speech-input/.venv/Scripts/python.exe -m unittest discover `
  -s services/speech-input/tests `
  -p "test_playback_echo_reference*.py" -v
```

O harness usa sinais sintéticos para ser determinístico e independente de
microfone, volume e sala. Ele valida o algoritmo, não substitui o ensaio acústico
real.

## Path, relógio e ciclo de vida

- O Core entrega o path do WAV pelo stdin privado do processo de captura; não há
  interpolação em shell.
- O Python exige path absoluto com extensão `.wav`, PCM não comprimido, tamanho
  e duração limitados, e carrega a referência em memória enquanto o arquivo ainda
  existe.
- O timestamp Unix é usado uma única vez na fronteira entre processos e sua idade
  é limitada a 500 ms. Alinhamento e expiração usam o relógio monotônico local,
  imune a correções posteriores do relógio do Windows.
- O início do bloco é capturado no callback de áudio e viaja junto do PCM. Assim,
  backlog causado pela carga da referência não desloca o alinhamento; `queueAgeMs`
  permanece disponível na telemetria para diagnóstico.
- Cada referência carrega a geração da `SpeechQueue`. Um evento terminal antigo
  não pode apagar o áudio de uma resposta nova.
- `playback=false`, interrupção e shutdown limpam a referência. Métricas devem
  registrar apenas geração, correlação, residual, atraso e custo; não precisam
  expor path completo ou conteúdo de áudio.

O protocolo atual é interno e confiável. Se futuramente o controle do capturador
for exposto a rede, plugin ou extensão, o path também deverá ser restrito ao
diretório temporário do Kokoro e aberto sem seguir reparse points/symlinks.

## Notification injection

A referência acústica só responde à semelhança do sinal e não altera o campo
`trust` de notificações. Permanecem obrigatórias as defesas existentes:

1. notificação derivada de email/calendário continua `untrusted-derived`;
2. uma transcrição iniciada durante esse aviso é descartada e pede repetição;
3. o filtro textual pós-STT continua como segunda linha contra eco;
4. conteúdo de notificação nunca vira tool/action automaticamente;
5. um aviso interrompido não é marcado como entregue.

Mesmo que a referência acústica falhe aberta, esse fluxo impede que áudio criado
a partir de texto externo seja interpretado como autorização para automação.

## Riscos ainda abertos (P1)

1. **Carga síncrona:** o início da referência decodifica/resampleia o WAV no loop
   de controle. Em 20 WAVs locais já existentes, a carga teve p50 de 13,177 ms,
   p95 de 32,113 ms e máximo frio de 170,772 ms no maior arquivo observado
   (4.971.644 bytes). O timestamp no callback mantém o alinhamento correto e a
   fila recupera o atraso, mas o ensaio físico deve confirmar o alvo de barge-in
   abaixo de 200 ms antes de decidir por um worker de preparação.
2. **Cauda e intervalo entre chunks:** o término explícito remove a referência
   imediatamente. Eco físico residual ou um pequeno intervalo até o próximo WAV
   pode ficar sem cobertura. Validar em hardware antes de decidir entre uma
   pequena cauda por geração e limpeza imediata.
3. **Gate, não AEC:** depois que fala diferente é reconhecida, o playback é
   cancelado, mas os primeiros blocos ainda podem conter mistura. A qualidade da
   transcrição durante barge-in precisa ser medida com voz humana e alto-falante
   reais.
4. **Acústica real:** reverberação, AGC, supressão do driver, volume, distância e
   resposta do microfone não são reproduzidos integralmente pelo fixture.

## Gate para ativação definitiva

Antes de reduzir thresholds ou declarar a etapa concluída em hardware:

- executar ao menos 30 interrupções em três volumes e duas distâncias;
- obter falso barge-in por eco abaixo de 1%;
- detectar fala sobreposta em pelo menos 95% das tentativas;
- medir `speech_start` p95 abaixo de 200 ms desde a fala válida;
- confirmar zero execução causada por notificações `untrusted-derived`;
- confirmar zero regressão de pitch, velocidade, `SpeechQueue`, streaming e
  fallback RMS.
