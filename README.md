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

## Serviços esperados

- Ollama instalado com o modelo configurado;
- `services/speech-whisper/build/bin/whisper-server.exe` compilado;
- ambientes Python em `services/speech-input/.venv`,
  `services/tts-kokoro/.venv` e `services/light-tuya/.venv`;
- credenciais Tuya apenas nos arquivos locais ignorados pelo Git.
