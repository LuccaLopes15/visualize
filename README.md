# Visualize

**Capture uma ideia em 2 segundos. Transforme-a em plano executável depois, com calma.**

Visualize é um app desktop para Windows que resolve um problema comum: ideias de sistemas, funcionalidades e refatorações surgem enquanto você trabalha em outra coisa, e se você não anota na hora, elas somem ou ficam nebulosas. O app captura a ideia sem quebrar seu foco e, depois, ajuda a levá-la de rascunho a plano de tarefas, com o Claude Code como parceiro de raciocínio.

```
ideia  →  board livre  →  plano macro  →  tarefas (grafo)  →  tickets no Azure DevOps
```

> **Status:** em desenvolvimento ativo, versão `0.1.0`. Fases 1 a 4 prontas; a integração com o Azure DevOps (fase 5) é a próxima.

## O que ele faz

- **Captura instantânea.** Um atalho global (`Ctrl+Alt+Space` por padrão, configurável) abre uma janelinha sem borda: digite o título, `Enter` salva, `Esc` fecha, e o foco volta para o app em que você estava.
- **Hub de ideias e projetos.** Ideias soltas ou vinculadas a um ou mais projetos (cada projeto aponta para uma pasta do seu PC). Uma ideia pode envolver vários projetos, com um principal.
- **Board livre.** Cada ideia tem um quadro [Excalidraw](https://excalidraw.com) com autosave, para rabiscar fluxos e arquiteturas.
- **Plano macro.** Editor Markdown com prévia ao lado do board.
- **Claude no workspace.** Um chat nativo que roda o **Claude Code já instalado e logado** na sua máquina. O Claude lê o código dos seus projetos (somente leitura), desenha no board, escreve o plano macro e monta o plano de tarefas por você.
- **Grafo de tarefas.** Stories, tasks e sub-tasks com dependências, que podem cruzar stories e projetos, em um grafo com layout automático. Dá para editar à mão ou pedir ao Claude ("quebra o plano macro em tarefas por projeto", "a tarefa Y depende da Z").
- **Segue o seu fluxo.** Fica na bandeja do sistema, inicia com o Windows (opcional) e mantém uma única instância.
- **Local e privado.** Tudo fica em um banco SQLite no seu PC. Nada é escrito nas pastas dos seus projetos.

## Como o Claude é integrado

O app não usa a API da Anthropic diretamente. Ele executa o Claude Code CLI em modo headless (`claude -p` com `stream-json`), usando a instalação e o login que você já tem:

- um processo por workspace aberto, com a sessão retomada via `--resume`;
- **acesso somente leitura ao código** (`Read`, `Glob`, `Grep`), sem editar arquivos nem rodar comandos;
- um **servidor MCP local** (`visualize`, em `127.0.0.1`, com token Bearer por sessão) que dá ao Claude as ferramentas para mexer no board, no plano macro e nas tarefas.

Detalhes e armadilhas em [`docs/spike-fase3.md`](docs/spike-fase3.md).

## Stack

| Camada | Tecnologia |
| --- | --- |
| Shell desktop | Electron + TypeScript, build com `electron-vite` |
| Interface | React 19, Excalidraw, React Flow (`@xyflow/react`) + dagre |
| Dados | SQLite via `better-sqlite3`, migrations versionadas |
| IA | Claude Code CLI + servidor MCP (`@modelcontextprotocol/sdk`) |
| Validação / testes | Zod, Vitest |
| Empacotamento | electron-builder (instalador NSIS) |

## Começando

**Pré-requisitos:** Windows, Node.js 22+ e, para usar o chat, o [Claude Code](https://claude.com/claude-code) instalado e logado.

```bash
npm install
npm run dev
```

Não é preciso Visual Studio Build Tools: o `better-sqlite3` usa binários pré-compilados.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | roda em desenvolvimento, com HMR no renderer |
| `npm test` | testes unitários (Vitest) |
| `npm run typecheck` | checa tipos (main/preload e renderer) |
| `npm run build` | typecheck + build de produção em `out/` |
| `npm run dist:win` | gera o instalador NSIS em `dist/` |

Para testar com um perfil separado e não misturar com seus dados: `VISUALIZE_USER_DATA=<pasta> npm run dev`.

## Roadmap

- [x] **Fase 1:** captura global, hub de ideias e projetos, bandeja, autostart
- [x] **Fase 2:** workspace da ideia com board (Excalidraw) e plano macro
- [x] **Fase 3:** chat com Claude Code e ferramentas de board e plano
- [x] **Fase 4:** aba Tarefas (grafo, edição manual e geração pelo Claude)
- [ ] **Fase 5:** criar os tickets no Azure DevOps (Story e Task, hierarquia, predecessores)
- [ ] **Fase 6:** terminal embutido opcional, busca no hub, instalador final

## Documentação

- [`docs/design.md`](docs/design.md): decisões de design e plano completo por fases
- [`docs/desenvolvimento.md`](docs/desenvolvimento.md): estrutura do código e notas técnicas
- [`docs/fase4-contract.md`](docs/fase4-contract.md): contrato do plano de tarefas (tipos, semântica, erros, eventos)
- [`docs/spike-fase3.md`](docs/spike-fase3.md): integração com o Claude Code CLI
