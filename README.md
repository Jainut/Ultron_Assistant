# Ultron

Assistente pessoal local com reconhecimento de voz por Whisper, IA via Ollama,
voz Kokoro, automação residencial e HUD em tempo real.

## Build e execução

Na raiz do projeto:

```cmd
npm run build
ultron.cmd
```

Para registrar `ultron` como comando global do npm:

```cmd
npm link
ultron
```

O HUD abre em `http://127.0.0.1:8787`. Para testar somente a interface:

```cmd
npm --prefix apps/core run hud
```

## Configuração local

Copie `ultron.env.example.cmd` para `ultron.env.cmd`. Esse arquivo é ignorado
pelo Git e pode definir modelo, microfone, voz e diagnósticos.

O perfil padrão preserva o comportamento e a voz originais:

- Whisper `ggml-medium.bin`;
- Ollama `qwen3:4b-instruct`;
- voz `pm_alex`, velocidade `0.85` e pitch `-5.5`;
- controle Tuya original da lâmpada;
- logs de desempenho ocultos, exceto quando `ULTRON_DEBUG=1`.

O Whisper continua usando `medium` por padrão. Nesta máquina o binário Vulkan
reconhece a RX 6600, e o modelo ocupa cerca de 2,1 GB de memória segundo a
documentação incluída do whisper.cpp. `large-v3` exige aproximadamente 3,9 GB e
prioriza precisão sobre resposta interativa; `large-v3-turbo-q5_0` pode ser
testado depois colocando o arquivo no serviço e definindo
`ULTRON_WHISPER_MODEL`, sem alterar o padrão funcional.

## Caminho rápido e contexto

Comandos determinísticos não passam pela LLM. Horário, aplicativos, arquivos,
pastas e automação residencial usam o router local e mantêm contexto curto:

```text
liga a luz e deixa em 20%
um pouco mais quente
abre meu projeto Fakeboxd
entra no backend e abre no VS Code
lista o que tem aqui
```

Aplicativos são indexados em background pelo Menu Iniciar, PATH, App Paths do
Registry, Microsoft Store e Program Files. As aliases antigas em
`apps/core/config/config.ts` continuam válidas e têm precedência.

Arquivos e pastas são procurados em Desktop, Documents, Downloads, Projects,
GitHub e OneDrive. Roots extras podem ser informados em `ULTRON_SEARCH_ROOTS`,
separados por ponto e vírgula. Não existem comandos rápidos destrutivos de
arquivo; criação, leitura, navegação e abertura são as operações liberadas.

## Interrupção de voz

O microfone permanece armado durante o playback com um threshold específico de
barge-in. Fala válida interrompe o áudio, esvazia a `SpeechQueue`, cancela a
síntese pendente e aborta o streaming do Ollama. Se o dispositivo configurado de
entrada não puder ser aberto, o capturador procura outro microfone real e evita
fontes de loopback como Mixagem Estéreo.

Com `ULTRON_DEBUG=1`, o terminal mostra intent, seleção e execução de tools,
resolução de aplicativos, primeiro token, primeiro chunk de TTS, playback e
tempo total. O modo normal continua conciso.

O estudo para uma memória de longo prazo baseada em notas interligadas está em
[`docs/OBSIDIAN_BRAIN.md`](docs/OBSIDIAN_BRAIN.md).

## Automação residencial

O Ultron descobre automaticamente os aparelhos da rede local ao iniciar e
atualiza o inventário a cada cinco minutos. São detectados SSDP/UPnP, mDNS,
Roku, Samsung, LG webOS, Android TV, TP-Link Kasa, Shelly, WLED e dispositivos
da conta Tuya já vinculada. O inventário interno fica em
`data/discovered-devices.json` e não precisa ser editado.

`config/home.devices.json` continua opcional como fallback para Home Assistant
ou para equipamentos que não anunciam nenhum protocolo. TVs desligadas só
podem ser aprendidas depois de terem sido encontradas ligadas ao menos uma vez;
fabricantes que exigem pareamento ainda mostrarão a autorização na própria TV.

Android TV/Google TV usa pareamento local apenas na primeira conexão. Diga
`pareie a televisão`; quando o PIN aparecer na tela, diga `código 1 2 3 4 5 6`.
O certificado fica salvo localmente em `data/android-tv-pairings.json` (ignorado
pelo Git). Depois disso, energia, volume, mute e reprodução não exigem cadastro
manual em `config/home.devices.json`.

A lâmpada Tuya mantém uma sessão Cloud persistente depois do primeiro fallback.
Por padrão, comandos de alteração usam atualização otimista após a API aceitar a
operação, evitando a espera e a consulta de estado adicionais. Defina
`ULTRON_TUYA_CONFIRM_COMMANDS=1` para restaurar confirmação síncrona em todas as
alterações; consultas de status sempre leem o estado real.

## Serviços esperados

- Ollama instalado com o modelo configurado;
- `services/speech-whisper/build/bin/whisper-server.exe` compilado;
- ambientes Python em `services/speech-input/.venv`,
  `services/tts-kokoro/.venv` e `services/light-tuya/.venv`;
- credenciais Tuya apenas nos arquivos locais ignorados pelo Git.
