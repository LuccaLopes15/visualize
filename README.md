# Visualize

App Windows para capturar ideias em 2 segundos e, depois, transformá-las em plano executável.
Design completo e fases: ver o plano do projeto. **Estado atual: Fase 3 (Claude no workspace).**

## Comandos

| Comando | O quê |
| --- | --- |
| `npm install` | instala dependências |
| `npm run dev` | roda o app em modo desenvolvimento (HMR no renderer) |
| `npm run typecheck` | checa tipos (main/preload e renderer) |
| `npm test` | testes unitários (vitest) |
| `npm run build` | typecheck + build de produção em `out/` |
| `npm run dist:win` | gera instalador NSIS em `dist/` (não usado na Fase 1) |

## Estrutura

```
src/
  shared/            tipos de domínio, contrato IPC tipado (ipc.ts) e shape de window.api (api.ts)
  main/
    index.ts         bootstrap: instância única, tray, atalho global, janelas, autostart
    db/              SQLite (better-sqlite3): conexão, migrations versionadas (PRAGMA user_version),
                     repositórios (ideas, projects, settings, boards, macroPlans) + testes
    ipc/             handlers por namespace (ideas:*, projects:*, settings:*, capture:*, boards:*, macro:*,
                     chat:*, claude:*, app:*)
    claude/          Claude Code CLI headless: resolução do executável (shim npm -> claude.exe), ambiente
                     limpo, argumentos, parser NDJSON, normalização de eventos, sessão por workspace
    mcp/             servidor MCP "visualize" (Streamable HTTP em 127.0.0.1, Bearer por sessão), tools e
                     ponte main -> renderer para as tools de board
    flush.ts         pede ao renderer para gravar autosaves pendentes (antes de sair / ao esconder)
    windows/         janela principal (hub) e janela de captura
    hotkey.ts tray.ts autostart.ts events.ts
  preload/           contextBridge -> window.api (tipado por shared/api.ts)
  renderer/
    index.html       hub          -> src/main.tsx
    capture.html     captura      -> src/capture.tsx
    src/             React (components/, hooks/, lib/, styles/)
      workspace/     workspace da ideia: Workspace (cabeçalho, abas, slot do chat), Board (Excalidraw,
                     chunk lazy), MacroPlanTab (markdown + prévia), boardService (API viva do board,
                     ponto de entrada da Fase 3), boardScene (o que é persistido)
      workspace/board/   tools de board do Claude: build (skeletons + layout dagre), summary (board_read),
                         ops (aplica na cena viva via updateScene)
      workspace/chat/    painel de chat (useChat guarda o estado do turno; ChatPanel renderiza)
resources/           ícones (app e bandeja)
```

## Notas

- **Dados**: `%APPDATA%\Visualize\visualize.db` no app instalado; em dev usa
  `%APPDATA%\Visualize (dev)\visualize.db` para não misturar. `VISUALIZE_USER_DATA=<pasta>` sobrescreve.
- **better-sqlite3 13** traz binários N-API pré-compilados (`prebuilds/`), que carregam tanto no Node
  (testes) quanto no Electron. Por isso não há rebuild no `postinstall` (`npmRebuild: false` no
  electron-builder) e não é preciso Visual Studio Build Tools.
- **Autostart** só é aplicado ao Windows quando o app está empacotado; em dev a preferência é só salva.
- **Nova migration**: acrescente um item em `src/main/db/migrations.ts` com `version` maior; nunca edite
  uma migration já publicada.
- **Workspace**: board (`boards` + imagens em `board_files`) e plano macro (`macro_plans`) ficam no banco,
  com cascade ao excluir a ideia. Autosave com debounce de 800 ms (`lib/autosave.ts`), gravado também ao
  trocar de aba, voltar ao hub, esconder a janela e antes de sair (main espera o `app:flushDone`, até 3 s).
- **Excalidraw offline**: as fontes saem de `node_modules/@excalidraw/excalidraw/dist/prod/fonts` e são
  servidas/copiadas em `excalidraw-assets/` (plugin em `electron.vite.config.ts`); o fallback para o CDN
  esm.sh é reescrito no bundle para o caminho local. A CSP não libera nenhum host externo.
- **Novo canal IPC**: declare em `src/shared/ipc.ts` (`IpcContract`), exponha em `src/shared/api.ts` +
  `src/preload/index.ts` e registre o handler em `src/main/ipc/`.
- **Claude (Fase 3)**: o chat roda o Claude Code **instalado e logado** do usuário (`claude -p` com stream-json),
  um processo por workspace aberto, encerrado ao sair do workspace/fechar o app; sessão retomada com `--resume`.
  Só leitura no código (`--tools Read,Glob,Grep`, `--permission-mode dontAsk`) + tools `mcp__visualize__*`;
  `--setting-sources project` e `--strict-mcp-config`. Detalhes e armadilhas (variáveis `CLAUDE_CODE_*` herdadas)
  em `docs/spike-fase3.md`. Caminho do executável e modelo ficam em Configurações (`claude_path`, `claude_model`).
- **Plano de tarefas (Fase 4, camada de dados)**: stories/tasks/dependências em `plan_nodes`/`plan_deps` (migration v4),
  regras em `src/main/db/repositories/plan.ts` + `src/shared/plan.ts` (helpers puros), `PlanService` em `src/main/plan/`
  e canais `plan:*`. Contrato completo (tipos, semântica de `replaceAll`/`mergeAdd`, erros, eventos): `docs/fase4-contract.md`.
