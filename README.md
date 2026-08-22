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

- Whisper `large-v3-turbo-q5_0` quando instalado, com fallback automático para
  `medium` e depois `small`;
- Ollama `qwen3:4b-instruct`;
- voz `pm_alex`, velocidade `0.85` e pitch `-5.5`;
- controle Tuya original da lâmpada;
- logs de desempenho ocultos, exceto quando `ULTRON_DEBUG=1`.

Na RX 6600, uma amostra sintética pt-BR de comandos do próprio Ultron teve WER
de 25,8% no `small`, 16,1% no `medium` e 3,2% no
`large-v3-turbo-q5_0`; a recuperação dos termos Ultron, Visual Studio Code,
Fakeboxd e Spotify foi 50%, 100% e 100%, respectivamente. É uma amostra curta e
não substitui gravações reais do usuário, mas justificou preferir o Turbo Q5
local: ele ocupa aproximadamente 573 MiB reportados pelo Vulkan, contra 1.533
MiB do `medium`, e foi mais rápido que o `medium` no fluxo persistente medido.
`ULTRON_WHISPER_MODEL` continua podendo fixar qualquer modelo explicitamente.

O capturador usa endpoint adaptativo de 280–400 ms e WebRTC VAD. Para recriar o
ambiente do microfone:

```cmd
services\speech-input\.venv\Scripts\python.exe -m pip install -r services\speech-input\requirements.txt
```

O Kokoro continua persistente e agora também reproduz WAVs no mesmo processo.
Isso elimina a abertura de um PowerShell por chunk; sistemas sem suporte a esse
protocolo continuam usando o player legado automaticamente. Voz, velocidade e
pitch não foram alterados.

Durante o playback, cada WAV também é enviado como referência privada ao
capturador. Antes de iniciar um barge-in, o microfone só descarta um bloco quando
correlação, atraso e energia residual indicam eco com alta confiança. Fala
diferente ou sobreposta continua passando; referência ausente ou inválida falha
aberta e preserva o comportamento anterior. Essa camada é um gate acústico
conservador, não um AEC adaptativo completo. O benchmark e os limites estão em
[`docs/P3_ACOUSTIC_ECHO_REFERENCE_VALIDATION.md`](docs/P3_ACOUSTIC_ECHO_REFERENCE_VALIDATION.md).

## Gmail, Google Tasks e Calendar

As três integrações usam o mesmo OAuth 2.0 para aplicativo Desktop, com PKCE e
callback loopback em `127.0.0.1`. O Ultron nunca abre o login durante o startup:
ele só inicia a autorização quando você diz `conecte minha conta Google`.

1. No Google Cloud, habilite Gmail API, Google Tasks API e Google Calendar API.
2. Crie um OAuth Client do tipo **Desktop app**.
3. Defina `ULTRON_GOOGLE_CLIENT_ID` no `ultron.env.cmd`. O client secret é
   opcional para esse fluxo e, se usado, fica apenas no arquivo local ignorado.
4. Inicie o Ultron e peça para conectar a conta Google.

O fluxo segue a documentação oficial de [OAuth para aplicativos Desktop com
PKCE e loopback](https://developers.google.com/identity/protocols/oauth2/native-app).
Os tokens ficam cifrados pelo DPAPI `CurrentUser` em
`%LOCALAPPDATA%\Ultron\secrets.dpapi.json`; tokens e conteúdo de email não são
gravados em logs nem enviados como instruções.

Exemplos do caminho rápido:

```text
leia meus emails novos
procure o email que fala do processo seletivo
resuma esse email
crie uma tarefa para responder esse email amanhã
liste minhas tarefas de amanhã
o que tenho hoje?
marque uma reunião com João sexta às 15h
```

Enviar email, excluir tarefa, cancelar evento e excluir automação exigem uma
confirmação explícita em outro turno. Um `sim` executa somente a ação pendente
da conversa atual; `não` ou `cancela` descarta a ação.

## Automações pessoais persistentes

O Automation Core salva agendas e monitores em `data/` e os recupera depois de
reiniciar o Ultron. A conta Google precisa estar configurada antes de criar uma
automação que dependa dela; caso contrário, o comando falha sem deixar um job
quebrado para trás.

```text
todo dia às 8 me diga meus compromissos e tarefas
quando chegar um email do GitHub sobre workflow falhando, me avisa
me avisa quinze minutos antes das reuniões
quais avisos pendentes eu tenho?
```

O Daily Briefing consulta Calendar, Tasks e Gmail em paralelo e continua útil
quando apenas uma fonte está temporariamente indisponível. Email Watch e
Calendar Reminder fazem polling em background, deduplicam eventos já avisados e
publicam no Notification Center persistente. Texto vindo de email ou calendário
é sempre marcado como dado externo não confiável: pode ser mostrado ou falado,
mas nunca vira instrução nem executa outra tool automaticamente.

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

O controle Android TV também aceita Home, Voltar, setas, OK, Menu, Entrada,
canal acima/abaixo, parar e mídia anterior/próxima. O comando de ligar só é
confirmado quando a TV responde com o estado real; o simples envio de
Wake-on-LAN nunca é anunciado como "TV ligada".

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
