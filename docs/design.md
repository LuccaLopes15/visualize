# Visualize — design e plano em fases

## Contexto
Ideias de sistemas/funcionalidades/refatorações aparecem durante o trabalho (codando, conversando com colegas). Foco está em outra tarefa → não anota → ideia some ou fica nebulosa. Objetivo: app Windows que (1) captura ideia em 2 segundos sem quebrar o foco e (2) depois, com calma, transforma a ideia em algo visual e executável: **ideia → board livre → plano macro → tarefas micro → tickets no Azure DevOps**, com o Claude Code ajudando a pensar e editando o board.

Pasta do projeto: `C:\Projetos\Exemplo\Visualize` (greenfield).

## Decisões do usuário
- Construir tudo, **em fases**; usuário testa cada fase e dá retorno antes da próxima.
- Dados num **banco central do app** (nada escrito nas pastas dos projetos).
- Destino no Azure DevOps **escolhido na hora** de criar os tickets.
- **PAT** do Azure DevOps num campo de configuração, tratado como segredo; a interface mostra quais escopos o PAT precisa.
- Projetos do app ficam vinculados a uma pasta do PC; o Claude roda nessa pasta.
- Chat **nativo do app**, com Claude por baixo e tools para mexer no board. Terminal embutido é aceitável como extra.
- Stack livre (decidida abaixo).
- **Claude = Claude Code CLI já instalado e logado** (assinatura do usuário), não Agent SDK. Login/cobrança vêm da instalação do usuário; uso pessoal, decisão do usuário ciente da política da Anthropic sobre uso de assinatura em apps de terceiros.
- **Azure DevOps Services (nuvem)**, organização `https://<sua-org>.visualstudio.com` (URL legado, equivalente a `https://dev.azure.com/<sua-org>`; app aceita os dois formatos). `api-version=7.1`. Campos obrigatórios customizados desconhecidos → descoberta automática.
- **Níveis:** só Story (tipo do processo: User Story/PBI/Requirement, descoberto) e Task; Task pode ser filha de Task. Nada acima de Story. **Uma ideia pode ter várias Stories.** **Ideia multi-projeto:** vincula 1+ projetos do app (padrão 1, um principal).

## Decisões minhas (podem ser vetadas)
- **Stack:** Electron + TypeScript + React (scaffold `electron-vite`), empacotado com `electron-builder` (instalador NSIS).
- **Banco:** SQLite via `better-sqlite3` em `app.getPath('userData')/visualize.db`, migrations versionadas simples.
- **Board livre:** `@excalidraw/excalidraw` (cena salva como JSON no banco).
- **Grafo de tarefas:** view própria com **React Flow (`@xyflow/react`) + auto-layout `dagre`** — fonte da verdade estruturada no banco (nós e arestas tipadas). Motivo: cards organizados/bonitos e mapeamento confiável pra tickets; desenho livre no Excalidraw seria frágil pra virar work item.
- **Claude (CLI):** main faz spawn de `claude -p --input-format stream-json --output-format stream-json --verbose`, com:
  - `cwd` = pasta do projeto **principal** da ideia; `--add-dir <pasta>` para cada outro projeto vinculado.
  - `--mcp-config <json temporário>` apontando pro servidor MCP HTTP local do app (ver abaixo) + `--strict-mcp-config` (ignora outros MCPs).
  - Acesso **só leitura** ao código: `--tools Read,Glob,Grep` (limita as tools nativas disponíveis), `--allowedTools "Read,Glob,Grep,mcp__visualize__*"` (auto-aprova; sem prompt no modo `-p`), `--disallowedTools Edit,Write,Bash,NotebookEdit`.
  - `--setting-sources project` — herda CLAUDE.md/.claude do projeto, mas não plugins/hooks do usuário.
  - Sessão por ideia: `session_id` lido do evento `system/init` e salvo; reabrir usa `--resume <session_id>`.
  - Mensagens do usuário entram como linhas JSON no stdin; eventos de streaming JSON do stdout são parseados e enviados ao renderer via IPC. Um processo por workspace aberto; encerrado ao fechar.
  - Caminho do executável `claude` configurável (padrão: resolver no PATH); Configurações mostram se foi encontrado e a versão (`claude --version`).
- **Tools do app via servidor MCP HTTP local** hospedado no main (`@modelcontextprotocol/sdk`, Streamable HTTP em `127.0.0.1`, porta aleatória, token Bearer aleatório por sessão passado no mcp-config via `headers`; requisição sem token é rejeitada). Nome do servidor `visualize` → tools `mcp__visualize__*`.
- **Board ao vivo pertence ao renderer.** Tools de board rodam no main mas só montam skeletons; enviam via IPC; renderer chama `convertToExcalidrawElements(skeletons, { regenerateIds: false })` + `excalidrawAPI.updateScene`, depois salva. Chat só existe com o workspace aberto, então Claude nunca edita board fechado. Edição simultânea: `updateScene` mescla por id, usuário segue desenhando.
- **Segredo:** PAT cifrado com `safeStorage` do Electron (DPAPI no Windows); nunca vai pro renderer; todas as chamadas DevOps no main.
- **Atalho padrão:** `Ctrl+Alt+Space` (configurável).

## Arquitetura
- **Main process:** tray, `globalShortcut`, janelas, SQLite, processo `claude` CLI + servidor MCP HTTP local, cliente Azure DevOps REST (`api-version=7.1`), safeStorage.
- **Preload:** API tipada via `contextBridge` (contextIsolation on, nodeIntegration off).
- **Renderer (React):** Hub, Workspace da ideia (abas Board / Plano macro / Tarefas + painel de chat à direita), Configurações, janela de captura.
- **Single instance** (`requestSingleInstanceLock`); fechar janela principal = minimiza pro tray; inicia com Windows (`setLoginItemSettings`, configurável).

### Modelo de dados
- `projects(id, name, folder_path, created_at)`
- `ideas(id, title, body, status[solta|em_trabalho|planejada|ticketada|arquivada], created_at, updated_at)` — ideia sem projeto vinculado = solta.
- `idea_projects(idea_id, project_id, is_primary)` — 1+ projetos por ideia; exatamente um principal.
- `boards(idea_id PK, scene_json, updated_at)`
- `macro_plans(idea_id PK, markdown, updated_at)`
- `plan_nodes(id, idea_id, kind[story|task], project_id, title, description, parent_id NULL, sort, devops_id NULL, devops_url NULL)` — `project_id` obrigatório em story; tasks herdam da story raiz.
- `plan_deps(from_id, to_id)` — "from depende de to" (pode cruzar stories/projetos).
- `devops_targets(project_id PK, devops_project, area_path, iteration_path NULL)` — última escolha de destino por projeto do app (pré-preenchimento).
- `chat_sessions(idea_id PK, cli_session_id)`, `chat_messages(id, idea_id, role, content_json, created_at)`
- `settings(key, value)` — `devops_org_url`, `devops_pat_enc` (blob cifrado), `claude_path`, `hotkey`, `autostart`

### Tools do Claude (MCP HTTP "visualize")
- Board: `board_read`, `board_add` (texto, retângulo, sticky, seta ligando elementos), `board_update`, `board_delete`.
  - `board_read` retorna lista de elementos com `id`, tipo, texto, posição/tamanho e conexões de setas; desenho livre resumido como "traço livre na região x,y,w,h"; imagens como "imagem".
  - Ids estáveis (gerados pelo app, `regenerateIds: false`) pra update/delete/setas. `convertToExcalidrawElements` é API beta.
- Plano macro: `macro_read`, `macro_write`.
- Tarefas: `tasks_read`, `tasks_create_node` (story exige `project_id` de um projeto vinculado), `tasks_update_node`, `tasks_set_parent`, `tasks_add_dep`, `tasks_remove_dep`, `tasks_delete_node`, `tasks_replace_all` (gera grafo inteiro de uma vez). `tasks_read` inclui a lista de projetos vinculados (id, nome, pasta).
- Tools rodam no main, gravam no banco e emitem evento IPC → renderer atualiza ao vivo (board: ver "Board ao vivo pertence ao renderer").

### Azure DevOps
- Config: URL da organização (aceita `https://<sua-org>.visualstudio.com` ou `https://dev.azure.com/<sua-org>`) + PAT. Tela mostra escopos necessários: **Work Items (Read & Write)** (cobre também área/iteração/tipos) e **Project and Team (Read)** (listar projetos). Botão "Testar conexão" (lista projetos). Campo do PAT nunca re-exibe o valor (só "configurado ✓" + trocar/remover).
- "Criar tickets" (aba Tarefas): diálogo agrupa por Story; **cada Story escolhe seu destino** (Projeto DevOps → Área → Iteração opcional), pré-preenchido com a última escolha usada pelo projeto do app daquela story (editável). Tipos carregados da API: story → tipo de requisito do processo (`User Story`/`Product Backlog Item`/`Requirement`), task → `Task`. Preview da árvore. Botão **Criar tudo**.
- Campos obrigatórios: diálogo descobre os de cada tipo/projeto (`GET .../wit/workitemtypes/{type}/fields?$expand=all`, `alwaysRequired`) e pede preenchimento antes de criar (decisão minha).
- Ordem: primeiro **todas as hierarquias** (pai antes de filho, link `System.LinkTypes.Hierarchy-Reverse` no create; Task filha de Task usa o mesmo link); depois 2ª passada adiciona dependências: no item "from" adiciona `System.LinkTypes.Dependency-Reverse` apontando pro "to" (predecessor). Dependências entre stories em projetos DevOps diferentes da mesma org são permitidas (links cross-project por URL do work item). Dependência circular é bloqueada no app antes de enviar. Idempotente: nó com `devops_id` é pulado; falha parcial pode ser retomada. Card mostra `#id` com link pro work item.
- Nó já ticketado editado localmente fica marcado "desatualizado" com botão "Atualizar no DevOps" (PATCH título/descrição); apagar nó ticketado pede confirmação e não apaga no DevOps (decisão minha).

## Fases (cada uma testável pelo usuário)

### Fase 1 — Captura + Hub
- Scaffold electron-vite React TS, tray, single instance, autostart, SQLite + migrations. `better-sqlite3`: rebuild via `electron-builder install-app-deps` no postinstall + externalizar no electron-vite (`externalizeDepsPlugin`).
- Atalho global → janelinha sem borda, sempre no topo, centralizada: título (+ detalhe opcional com Shift+Enter/Tab), Enter salva, Esc fecha. Volta o foco pro app anterior.
- Hub: lista de ideias soltas, grid de projetos (nome + pasta), criar/editar/arquivar, vincular ideia a 1+ projetos (existente ou novo com seletor de pasta). Ideia aparece em cada projeto vinculado.
- **Teste:** de qualquer app, `Ctrl+Alt+Space`, digita, Enter; ideia aparece no hub; persiste após reiniciar o PC.

### Fase 2 — Workspace + Board
- Abrir ideia (exige 1+ projeto vinculado; se solta, pede vínculo) → workspace com abas Board (Excalidraw, autosave debounced), Plano macro (editor markdown com preview). Gerenciar projetos vinculados (adicionar/remover/definir principal).
- **Teste:** desenhar, escrever plano, vincular segundo projeto, fechar app, reabrir, tudo preservado.

### Fase 3 — Claude no workspace
- Passo 1 (spike): na versão instalada do CLI, validar (`claude --help`) as flags usadas (`--input-format/--output-format stream-json`, `--tools`, `--allowedTools`, `--disallowedTools`, `--add-dir`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, `--resume`); round-trip de uma tool MCP HTTP alterando o board; resume de sessão após reiniciar o app. Ajustar o plano se alguma flag divergir.
- Configurações: caminho do `claude` + status encontrado/versão.
- Painel de chat com streaming, histórico por ideia, sessão retomável, indicador de tool em execução.
- Tools de board e plano macro.
- **Teste:** "desenha o fluxo que pensei pra X" → elementos aparecem no board; "escreve o plano macro" → aba atualizada; Claude cita arquivos reais do projeto principal e dos vinculados; pedido de editar arquivo é recusado.

### Fase 4 — Tarefas (grafo)
- Aba Tarefas: React Flow, nó story (destaque) e task, arestas "filha" (sólida) e "depende de" (tracejada), auto-layout dagre, stories agrupadas/coloridas por projeto, edição manual (criar, renomear, descrição, projeto da story, ligar, apagar).
- Tools `tasks_*`; Claude gera a quebra a partir do plano macro (várias stories, uma por projeto quando fizer sentido).
- **Teste:** pedir ao Claude a quebra em tarefas; resultado igual ao esboço (stories → tasks → subtasks + dependências, inclusive entre stories), editável.

### Fase 5 — Azure DevOps
- Configurações com PAT seguro + escopos visíveis + testar conexão.
- Diálogo Criar tickets completo (destino por Story), criação em ordem, links, idempotência, feedback de progresso/erro, `#id` nos cards.
- **Teste:** num projeto/área de teste no Azure DevOps, criar tudo; conferir hierarquia (incl. Task filha de Task) e predecessores no Azure; caso com **2 stories em 2 projetos DevOps distintos com dependência entre elas**; rodar de novo não duplica.

### Fase 6 — Extras e entrega
- Terminal embutido opcional (xterm.js + node-pty rodando `claude` na pasta do projeto principal).
- Configurações de atalho/autostart, busca no hub, instalador NSIS.
- Empacotamento: `better-sqlite3` fora do asar (`asarUnpack`).

## Fora do escopo
- Sincronizar de volta mudanças feitas no Azure DevOps; multiusuário/nuvem; mobile; níveis acima de Story (Feature/Epic).

## Verificação
- Cada fase: `npm run dev` e roteiro de teste da fase acima, executado pelo usuário; eu valido antes com o app rodando (screenshots) e testes unitários na lógica pura (repositórios SQLite, ordenação topológica, parser do stream JSON do CLI, montagem dos JSON Patch do DevOps).
- Fase 5: testes do cliente DevOps com fetch mockado + teste manual num projeto sandbox.
