# P4 — instância única, IPC e comandos no terminal

## Comandos

Depois de `npm run build`, o launcher existente continua sendo `ultron`:

```cmd
ultron
ultron status
ultron hud
ultron "liga a luz"
ultron "sim"
ultron stop
ultron restart
ultron --help
```

- `ultron`/`ultron start`: inicia em primeiro plano ou reutiliza a instância existente. O terminal original e Ctrl+C continuam disponíveis.
- `status`: consulta `starting`, `ready`, `degraded` ou `stopping`, PID, HUD e fila. Não carrega voz/modelos. Ausência retorna código 3.
- `hud`: abre somente o endereço `http://127.0.0.1:<porta>/` informado pela instância existente. Não aceita URL arbitrária.
- Texto: confirma **recebimento**, não execução. A resposta real continua aparecendo no HUD/voz. Sem instância, inicia o runtime e entrega o texto inicial.
- `stop`: solicita shutdown e espera a instância alvo encerrar. Se já estiver parada, é idempotente.
- `restart`: solicita shutdown, espera o pipe e o processo anterior encerrarem e só então tenta adquirir a instância novamente. Timeout de 15 s não gera kill forçado nem segunda instância.
- `--` permite enviar uma palavra reservada como texto, por exemplo `ultron -- "stop"`.

`ultron.cmd`, o executável npm `bin/ultron.cjs`, `npm run dev`, `npm start` e a invocação direta de `index.js` continuam disponíveis. O `.cmd` preserva o carregamento do `ultron.env.cmd`; a flag interna evita aplicar o ambiente duas vezes. O bin agora exige o build atualizado de `cli.js`.

## Aquisição antes da voz

O caminho do launcher importa apenas o cliente IPC/configuração. O `index.ts` com STT, Kokoro, Ollama e tools é importado dinamicamente **depois** da aquisição do singleton. Uma segunda chamada não inicia Whisper, Kokoro, Ollama, microfone, descoberta ou índices.

O namespace é derivado da raiz canônica da instalação e da identidade/diretório do usuário. No Windows, a exclusão usa um named pipe com `exclusive: true`; o libuv solicita `FILE_FLAG_FIRST_PIPE_INSTANCE` no bind. Não há lockfile que precise ser apagado para ganhar a disputa. O kernel remove o pipe ao fechar os handles do processo.

Se o canal estiver ocupado mas responder com protocolo desconhecido, houver acesso negado, resposta truncada ou timeout, o CLI falha conservadoramente. Não tenta outra porta/pipe para criar um segundo Ultron. Dois launchers concorrentes disputam o mesmo bind; somente o vencedor importa o runtime.

Há também uma sondagem TCP sem payload na porta configurada do Whisper antes de iniciar um runtime novo. Porta ocupada com IPC ausente pode indicar versão antiga ou serviço órfão; esse caso bloqueia a inicialização com explicação. Não mata processos encontrados nem tenta reutilizar um servidor de origem desconhecida.

## Mesmo fluxo, mesmas confirmações

O IPC aceita somente `status`, `hud`, `stop` e texto. Não aceita nomes de tools, grants, flags de aprovação ou objetos de confirmação.

Textos recebidos entram em uma fila em memória de no máximo oito itens e participam do mesmo loop que recebe STT e notificações. Reutilizam `FastIntentRouter`, LLM, contexto operacional e `conversationId`. Assim, `ultron "sim"` responde à confirmação que já estiver pendente; não constitui bypass das políticas da registry.

Um texto novo interrompe a fala/geração ativa via o mesmo `AbortController`, cancelamento da IA e `SpeechQueue.interrupt()`. O loop permanece serial: não cria outra instância de router nem executa tools simultaneamente por fora dele. A escuta STT já armada é preservada, sem chamar `listen()` duas vezes.

O cancelamento não desfaz uma ação física ou alteração que já ocorreu. Comandos já recebidos são processados em ordem; `stop` descarta a fila durante shutdown. Acordar pelo terminal é explícito e não exige repetir a wake word.

## Protocolo e limites

- Identificador `ultron-instance`, versão 1, request ID único.
- Uma requisição/resposta JSON UTF-8 por conexão; limite de 16 KiB por frame.
- Texto de até 8 KiB, sem caracteres de controle do terminal; o frame serializado também precisa caber no limite.
- Até 16 clientes simultâneos; entrada incompleta expira em 3 s.
- Cliente aguarda até 2 s por resposta e nunca reenvia comandos automaticamente após resultado incerto.
- IDs de comandos/stop já recebidos são lembrados em cache limitado a 256 entradas/5 min para evitar duplicação em repetições imediatas.
- Comando fica em estágio provisório até a escrita da confirmação; desconexão antes desse ponto cancela o estágio. Após confirmação, o comando pertence ao loop principal e pode continuar mesmo quando o CLI fecha.
- Frames extras, JSON inválido, versões desconhecidas e campos não permitidos não executam ações.

## Segurança do canal

O hash no nome do pipe **não é autenticação nem segredo**. A autorização é a ACL do Windows. O servidor não habilita `readableAll`/`writableAll`; o teste Windows consulta a ACL do pipe real e verifica que não existem concessões de escrita para identidades amplas/desconhecidas, além de abrir o canal duplex como o usuário atual. Administradores/SYSTEM continuam no limite de confiança do Windows; o IPC não protege contra processos maliciosos já executando como o próprio usuário ou administrador.

Não existe endpoint HTTP de execução nem uma nova porta TCP de controle. O cliente usa o namespace local `\\.\pipe\`. Políticas de compartilhamento/credenciais do Windows continuam sendo responsabilidade do sistema operacional: isto não é uma API pública para clientes de rede. Em Unix, o suporte usa diretório privado 0700 e socket 0600; socket stale/identidade desconhecida não é removido automaticamente. O alvo validado desta etapa é Windows.

Referências primárias: [IPC e permissões no Node](https://nodejs.org/api/net.html#ipc-support), [bind do pipe no libuv](https://github.com/libuv/libuv/blob/v1.x/src/win/pipe.c), [segurança de named pipes no Windows](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).

## Shutdown incremental

A rotina existente agora interrompe a resposta ativa e fecha STT, TTS, HUD, descoberta, ambos os workers Tuya, sessões Android TV e os índices de apps/arquivos. A persistência do Automation Core é aguardada. O singleton só é liberado no fim dessa rotina; no restart, o CLI também verifica que o PID anterior encerrou, sem enviar sinais destrutivos a um PID arbitrário.

O preload do daemon Tuya ocorre depois da voz/tools prontas e não faz descoberta, autenticação ou ação física. `degraded` informa falha detectada ao iniciar o Automation Core; não pretende substituir health checks individuais de todos os providers.

## Validação

`npm run check` e os testes `instance-control.test.ts` cobrem parser, queue/ACK, ids repetidos, limites, input parcial, cancelamento, timeout sem replay, status, CLI sem runtime, protocolo estranho, migração de porta ocupada e encerramento/restart.

Dois subprocessos fake simultâneos confirmaram aquisição exclusiva no Windows. Outro subprocesso fake confirmou o restart sem sobrepor donos. Um pipe isolado foi inspecionado com `PipeStream.GetAccessControl()`: usuário atual conectado em duplex e zero writers inesperados. Nenhum desses testes carrega modelos, abre microfone ou executa comandos em dispositivos reais.

A validação física de voz/televisão/lâmpada continua separada; os testes desta etapa não afirmam que uma ação residencial aconteceu.

No fechamento, `npm test` recompilou o workspace e aprovou 361 testes. O launcher
compilado também respondeu a `--help` e `status` sem carregar os serviços;
`status` sem instância retornou o código 3 esperado.
