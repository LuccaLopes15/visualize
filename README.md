# Visualize

App Windows para capturar ideias em 2 segundos e, depois, transformá-las em plano executável.
Design completo e fases: ver o plano do projeto. **Estado atual: Fase 1 (Captura + Hub).**

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
                     repositórios (ideas, projects, settings) + testes
    ipc/             handlers por namespace (ideas:*, projects:*, settings:*, capture:*, app:*)
    windows/         janela principal (hub) e janela de captura
    hotkey.ts tray.ts autostart.ts events.ts
  preload/           contextBridge -> window.api (tipado por shared/api.ts)
  renderer/
    index.html       hub          -> src/main.tsx
    capture.html     captura      -> src/capture.tsx
    src/             React (components/, hooks/, lib/, styles/)
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
- **Novo canal IPC**: declare em `src/shared/ipc.ts` (`IpcContract`), exponha em `src/shared/api.ts` +
  `src/preload/index.ts` e registre o handler em `src/main/ipc/`.
