# Spike — Fase 3 (Claude Code CLI headless + MCP HTTP)

Data: 2026-10-27 · CLI testado: **Claude Code 2.1.311** (Windows 11, instalação via npm) · modelo do spike: `haiku`
(prompts curtíssimos; custo total do spike < US$ 0,01).

## Executável no Windows

- `where claude` → `%APPDATA%\npm\claude` (sh), `claude.cmd` e `claude.ps1` — shims do npm.
- O `claude.cmd` só chama o binário nativo:
  `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`.
- **Decisão:** o app nunca usa `shell: true`. Resolve o executável real:
  1. caminho configurado (`claude_path`) — se for `.cmd`/`.ps1`/sem extensão, aplica a mesma resolução do shim;
  2. PATH: procura `claude.exe` (instalador nativo, ex.: `%USERPROFILE%\.local\bin\claude.exe`) e depois
     `claude.cmd`, lendo o shim para achar o `.exe` (ou o `cli.js` de versões antigas, executado com `node`);
  3. locais conhecidos (`%USERPROFILE%\.local\bin`, `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin`).
- `spawn(exe, args, { shell: false })` — argumentos com espaços (pasta `proj dir`, JSON do mcp-config, system
  prompt multilinha) passam intactos.

## Flags (todas existem em 2.1.311 e se comportaram como esperado)

| Flag | Resultado |
| --- | --- |
| `-p --input-format stream-json --output-format stream-json --verbose` | processo fica vivo lendo linhas JSON do stdin; um `result` por turno |
| `--include-partial-messages` | `stream_event` com `content_block_start/delta/stop` (deltas `text_delta`, `thinking_delta`, `input_json_delta`) |
| `--mcp-config '<json>'` | aceita a string JSON direto (não precisa arquivo temporário) |
| `--strict-mcp-config` | só o servidor `visualize` aparece em `mcp_servers` |
| `--tools Read,Glob,Grep` | restringe as tools nativas (ver armadilha abaixo) |
| `--allowedTools Read,Glob,Grep,mcp__visualize__*` | wildcard funciona: tool MCP executada sem prompt |
| `--disallowedTools Edit,Write,...` | aceito (defesa extra; as tools já nem existem com `--tools`) |
| `--setting-sources project` | ignora `~/.claude/settings.json` do usuário (plugins, hooks, modo de agente) |
| `--add-dir`, `--model`, `--append-system-prompt`, `--resume <id>` | ok |
| `--permission-mode dontAsk` | o que não está pré-aprovado é **negado** em vez de pedir permissão → nunca trava no modo headless |

Extras vistos no `--help` e não usados: `--permission-prompts none`, `--restricted`, `--system-prompt-snapshot`,
`--max-budget-usd`, `--session-id`.

### Armadilhas encontradas

1. **Variáveis de ambiente herdadas.** Rodando dentro de outra sessão do Claude Code (terminal do VS Code, Claude
   Desktop, `npm run dev` disparado por um agente) o processo herda `CLAUDECODE=1`, `CLAUDE_CODE_COORDINATOR_MODE=1`,
   `CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1`, `MCP_CONNECTION_NONBLOCKING`, etc. Com elas o CLI sobe em modo
   coordenador (tools `Task, ListAgents, SendMessage...`) e **`--tools Read,Glob,Grep` resulta em zero tools**.
   → O app limpa o ambiente antes do spawn (remove `CLAUDECODE`, `CLAUDE_CODE_*` exceto credenciais/provedor
   — `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `CLAUDE_CODE_GIT_BASH_PATH` —,
   `CLAUDE_AGENT_SDK_*`, `MCP_*`, `ANTHROPIC_BASE_URL`).
2. **Settings globais do usuário mudam as tools padrão.** Sem `--setting-sources project` o init lista as tools de
   agente do settings do usuário. Com `--setting-sources project` + `--tools Read,Glob,Grep` o init fica
   exatamente `["Glob","Grep","Read","mcp__visualize__ping_board"]`.
3. `system/init` é emitido **a cada turno** (não só no primeiro) com o mesmo `session_id`.
4. `total_cost_usd` do `result` é acumulado do processo → o app mostra o delta do turno.

## Round-trip MCP (Streamable HTTP + Bearer)

Servidor de teste: `@modelcontextprotocol/sdk` 1.32 (`McpServer` + `StreamableHTTPServerTransport` stateless, JSON
response), `http.createServer` em `127.0.0.1:0`, rejeita com 401 qualquer `Authorization` ≠ `Bearer <token>`.

```
mcp-config: {"mcpServers":{"visualize":{"type":"http","url":"http://127.0.0.1:<port>/mcp",
             "headers":{"Authorization":"Bearer <token>"}}}}
```

- `curl` sem token → **401**; com token → `tools/list` ok.
- init: `"mcp_servers":[{"name":"visualize","status":"connected"}]`, tool exposta como **`mcp__visualize__ping_board`**.
- Prompt "Call the ping_board tool with word abacaxi" → `tool_use` `mcp__visualize__ping_board {"word":"abacaxi"}`;
  servidor registrou `TOOL CALLED word=abacaxi` e todas as requisições chegaram com `Bearer <token>`;
  `tool_result` `pong:abacaxi` voltou no evento `user`.

## Sessão, resume e interrupção

- Mesmo processo, 3 turnos: 2º turno lembrou a palavra do 1º e leu `notes.txt` com `Read` (contexto mantido).
- **Resume entre processos:** novo processo com `--resume 8d7be5da-…` → "I sent the word "abacaxi" to the ping tool."
  O `session_id` continua o mesmo.
- **Interrupção:** `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}` no stdin →
  `control_response success` imediato, evento `user` "[Request interrupted by user]" e
  `result/error_during_execution`. O processo continua vivo e o turno seguinte funcionou normalmente.

## Somente leitura

Pedido "crie hello.txt e rode `echo hi > x.txt`" → resposta: "I can't do either… My available tools are Glob, Grep,
Read, and the ping_board tool". Nenhum arquivo criado, nenhum prompt de permissão, turno terminou normalmente.

## Não logado

Com `CLAUDE_CONFIG_DIR` vazio: evento `assistant` com `"error":"authentication_failed"` e texto
"Not logged in · Please run /login", seguido de `result` com `is_error:true`. O processo não sai sozinho (stdin aberto).
→ O app detecta `authentication_failed` / `is_error` com esse texto e mostra "faça login com `claude` no terminal".
`claude auth status` devolve JSON (`loggedIn`, `authMethod`, `subscriptionType`) — usado no botão "Testar".

## Decisão: processo longo por workspace aberto

**Um processo `claude` por workspace aberto**, com stream-json no stdin (multi-turno), criado no primeiro envio e
encerrado ao sair do workspace / fechar o app. Motivos: sem custo de boot (~1 s) a cada mensagem, o servidor MCP
conecta uma vez, interrupção nativa via `control_request` sem matar o processo. O `session_id` é salvo no banco a
cada `init`; se o processo morrer (crash, app fechado), o próximo envio cria outro com `--resume <id>`.
Se o `control_request` de interrupção não for confirmado em 3 s, o app mata o processo e retoma na próxima mensagem.
