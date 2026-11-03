# Fase 4 — contrato da camada de dados do plano de tarefas

Referência para a UI (Tarefa 2) e para as tools MCP `tasks_*` (Tarefa 3). Tudo aqui está implementado e testado
(`src/main/db/plan.test.ts`, `src/main/plan/service.test.ts`, `src/shared/plan.test.ts`).

## Arquivos

| Arquivo | O quê |
| --- | --- |
| `src/shared/types.ts` (seção Fase 4) | tipos: `PlanNode`, `PlanDep`, `PlanGraph`, specs, resultados |
| `src/shared/plan.ts` | `PlanError`/`PlanErrorCode` + helpers puros (renderer e main) |
| `src/main/db/migrations.ts` (v4) | tabelas `plan_nodes`, `plan_deps` |
| `src/main/db/repositories/plan.ts` | `PlanRepository` (toda a regra de domínio) |
| `src/main/plan/service.ts` | `PlanService` = repositório + notificação `dataChanged`. **Ponto de entrada para IPC e MCP** |
| `src/shared/ipc.ts`, `api.ts`, `src/preload/index.ts`, `src/main/ipc/index.ts` | canais `plan:*` → `window.api.plan.*` |

## Modelo e decisões

- `plan_nodes(id TEXT uuid, idea_id, kind 'story'|'task', title, description, parent_id, project_id, sort, devops_id, devops_url, devops_synced_at, created_at, updated_at)`
  e `plan_deps(from_id, to_id)` ("from depende de to"). Um `CHECK` no banco garante: story ⇒ `parent_id NULL` e `project_id` preenchido;
  task ⇒ `parent_id` preenchido e `project_id NULL`.
- **Projeto da task = derivado.** Tasks guardam `project_id = NULL`; o projeto efetivo é o da story raiz, calculado em `getGraph`
  (`PlanNode.projectId`, sempre número). Assim mover task / trocar o projeto da story nunca dessincroniza nada.
- **Stories**: `projectId` obrigatório e tem que estar vinculado à ideia (`idea_projects`). Pode haver várias stories, em projetos diferentes.
- **Tasks**: `parentId` obrigatório (story ou outra task **da mesma ideia**, qualquer profundidade). Passar `projectId` em task só é aceito se
  igual ao da story (senão `task_project_derived`).
- **Hierarquia é floresta**: mover nó para si mesmo/descendente → `hierarchy_cycle`. Story não pode ter pai; task não pode virar raiz
  (`setParent` com `null` só vale para story, e só reordena).
- **Dependências**: mesma ideia, sem auto-dependência, sem duplicata, **sem ciclo** (mensagem lista o ciclo: `"A" → "B" → "A"`). Podem cruzar
  stories e projetos. Não há restrição entre pai/filho (permitido).
- **Ordem (`sort`)**: inteiro 0-based entre irmãos (mesmo pai; stories = `parent_id NULL`). O repositório mantém contíguo (0..n-1) ao criar/mover/apagar.
  `createNode.index`, `updateNode.sort` e `setParent.index` são posições (clamp ao fim); `reorder` define a ordem completa.
- **Título**: trim, não vazio, ≤ 255. **Descrição**: markdown opcional, trim, ≤ 50.000 (`''` quando vazia).
- **`updatedAt`** só muda quando título/descrição realmente mudam (mover/reordenar/trocar projeto não "suja" um ticket). `createdAt` fixo.
- **Campos Fase 5** (`devopsId`, `devopsUrl`, `devopsSyncedAt`): `null` até a Fase 5. `PlanNode.devopsStale =
  devopsId != null && (devopsSyncedAt == null || updatedAt > devopsSyncedAt)`. `PlanService.setDevops(ideaId, nodeId, {devopsId, devopsUrl, syncedAt})`
  grava/limpa (só no main, sem canal IPC; não mexe em `updatedAt`).
- **Guard de desvincular/excluir projeto**: `IdeasRepository.unlinkProject` e `ProjectsRepository.delete` lançam `PlanError('project_in_use')`
  enquanto houver **stories** usando o projeto (mensagem lista as stories). A saída é mudar o projeto das stories (`updateNode {projectId}`) ou apagá-las.
  O FK `plan_nodes.project_id` é `RESTRICT` como rede de segurança. Tasks não bloqueiam (não guardam projeto). Os canais `ideas:unlinkProject` /
  `projects:delete` existentes passam a rejeitar com essa mensagem — a UI deve exibir o erro.
- Apagar ideia apaga tudo (cascade). Apagar nó apaga a subárvore e todas as dependências que toquem qualquer nó apagado.

## Tipos (resumo; ver `src/shared/types.ts`)

```ts
PlanNode  { id: string(uuid); ideaId; kind: 'story'|'task'; title; description; parentId: string|null;
            projectId: number /*efetivo*/; rootStoryId: string; depth: number /*story=0*/; sort;
            devopsId|null; devopsUrl|null; devopsSyncedAt|null; devopsStale: boolean; createdAt; updatedAt }
PlanDep   { fromId, toId }                       // fromId depende de toId
PlanGraph { ideaId; nodes: PlanNode[]; deps: PlanDep[] }   // nodes em pré-ordem: story, sua subárvore, próxima story…
PlanOverview { graph: PlanGraph; projects: {id,name,folderPath,isPrimary}[] }   // o que `tasks_read` deve devolver
NewPlanNodeInput { kind; title; description?; parentId?; projectId?; index? }
PlanNodePatch    { title?; description?; sort?; projectId? /*só story*/ }
PlanSpecNode { tempId?; id? /*só replaceAll*/; title; description?; projectId? /*story*/; children?: PlanSpecNode[] }
PlanSpec     { stories: PlanSpecNode[]; deps?: {from, to}[] }       // replaceAll
PlanAddSpec  { nodes: PlanSpecNode[]; deps?: {from, to}[] }         // mergeAdd
PlanWriteResult  { idMap: Record<string,string>; created; updated; deleted; deletedIds }
PlanDeleteResult { deletedIds: string[] /*pré-ordem*/; ticketed: {id,title,devopsId}[] }
```

## `PlanService` (main) — use isto nas tools MCP

Instância única criada em `src/main/index.ts` (`const plan = new PlanService(repos.plan, notifyPlanChanged)`), já passada ao `registerIpc`.
Tarefa 3: injete o mesmo objeto em `McpToolDeps`. **Todo método recebe `ideaId` primeiro e valida que o nó pertence à ideia**
(`cross_idea` caso contrário), então uma sessão do chat nunca mexe em outra ideia. Toda mutação chama `notify(ideaId)` (→ evento abaixo).
Erros de regra lançam `PlanError { code, message(pt-BR) }`; as tools MCP devem devolver `message` ao Claude (o `guard()` atual já faz isso).

```ts
getGraph(ideaId): PlanGraph          overview(ideaId): PlanOverview         getNode(ideaId, nodeId): PlanNode
createNode(ideaId, NewPlanNodeInput): PlanNode
updateNode(ideaId, nodeId, PlanNodePatch): PlanNode
setParent(ideaId, nodeId, parentId|null, index?): PlanNode
reorder(ideaId, parentId|null, orderedIds[]): void          // lista exata dos irmãos atuais
addDep(ideaId, fromId, toId): PlanDep                       // dep_self | dep_duplicate | dep_cycle | cross_idea
removeDep(ideaId, fromId, toId): boolean                    // false = não existia (idempotente, sem evento)
deleteNode(ideaId, nodeId, force = false): PlanDeleteResult // ticketed_nodes se a subárvore tem tickets e !force
replaceAll(ideaId, PlanSpec, { force? }): PlanWriteResult
mergeAdd(ideaId, PlanAddSpec, parentId?|null): PlanWriteResult
setDevops(ideaId, nodeId, { devopsId, devopsUrl, syncedAt }): PlanNode   // Fase 5, sem IPC
```

Mapeamento sugerido para as tools: `tasks_read`→`overview`; `tasks_create_node`→`createNode`; `tasks_update_node`→`updateNode`;
`tasks_set_parent`→`setParent`; `tasks_add_dep`/`tasks_remove_dep`→`addDep`/`removeDep`; `tasks_delete_node`→`deleteNode` (sem `force`: se
vier `ticketed_nodes`, devolva a mensagem e deixe o usuário decidir); `tasks_replace_all`→`replaceAll` (sem `force`); `mergeAdd` para "adicione
tasks sob X" sem risco de apagar.

## `replaceAll(ideaId, spec, { force })` — semântica

Substitui o grafo inteiro **atomicamente** (uma transação; qualquer violação desfaz tudo).

1. Nós do spec **sem `id`** são **criados** (UUID novo). `tempId` (opcional, único no spec, ≤100 chars) serve para `deps` e para o `idMap` devolvido.
2. Nós do spec **com `id`** (id de nó existente **desta ideia**, no mesmo papel: nível de topo = story, aninhado = task) são **mantidos e
   atualizados no lugar**: mesmo UUID, `createdAt` e campos `devops_*`; título/descrição/pai/projeto/ordem passam a ser os do spec.
   `updatedAt` só muda se título/descrição mudarem. É assim que se preserva nó já ticketado (e a UI/Claude podem preservar qualquer nó).
3. Nós existentes **ausentes do spec são apagados** (com a subárvore que não foi reenviada e suas dependências).
   Se algum deles já tem ticket (`devops_id`) e **`force` não foi passado → erro `ticketed_nodes`** (mensagem lista `#id "título"`), nada muda.
   Com `force: true` eles são descartados (o work item no DevOps nunca é tocado).
4. **Todas** as dependências existentes são descartadas e substituídas por `spec.deps` (referências `from`/`to` = `tempId` ou `id` de nó do spec; duplicatas colapsam;
   referência desconhecida → `spec_invalid`; auto-dep → `dep_self`; ciclo → `dep_cycle`).
5. Validações do spec (`spec_invalid` & cia.): título válido em todos os níveis; story com `projectId` vinculado; `projectId` em task, se presente, igual ao da story;
   `tempId`/`id` repetidos; `id` desconhecido/de outra ideia; mesmo `id` duas vezes; troca de papel (story↔task); até 2000 nós e 50 níveis.
6. Retorno: `idMap` mapeia **cada** `tempId` e cada `id` mantido → id real; `created/updated/deleted/deletedIds`.

Dica para o Claude: sem nós ticketados, basta mandar o grafo novo (sem `id`). Se existirem tickets, `tasks_read` devolve `devopsId`; reenvie esses nós
com `id` para preservá-los.

## `mergeAdd(ideaId, spec, parentId?)` — semântica

Só adiciona, nunca apaga. Com `parentId` (story ou task): `spec.nodes` são tasks (aninhadas à vontade), anexadas **depois** dos filhos atuais.
Sem `parentId`: `spec.nodes` são novas stories (exigem `projectId` vinculado), no fim da lista. `id` no spec é proibido (`spec_invalid`).
`deps` aceitam `tempId` dos nós novos **e** ids de nós existentes da ideia; o ciclo é verificado contra as dependências já existentes.
Retorna `PlanWriteResult` com `deleted: 0`.

## Canais IPC (`window.api.plan.*`; args exatamente como no `IpcContract`)

| Canal | `window.api.plan` | Retorno |
| --- | --- | --- |
| `plan:getGraph(ideaId)` | `getGraph` | `PlanGraph` |
| `plan:overview(ideaId)` | `overview` | `PlanOverview` |
| `plan:createNode(ideaId, input)` | `createNode` | `PlanNode` |
| `plan:updateNode(ideaId, nodeId, patch)` | `updateNode` | `PlanNode` |
| `plan:setParent(ideaId, nodeId, parentId\|null, index?)` | `setParent` | `PlanNode` |
| `plan:reorder(ideaId, parentId\|null, orderedIds)` | `reorder` | `void` |
| `plan:addDep(ideaId, fromId, toId)` | `addDep` | `PlanDep` |
| `plan:removeDep(ideaId, fromId, toId)` | `removeDep` | `boolean` |
| `plan:deleteNode(ideaId, nodeId, force?)` | `deleteNode` | `PlanDeleteResult` |
| `plan:replaceAll(ideaId, spec, force?)` | `replaceAll` | `PlanWriteResult` |
| `plan:mergeAdd(ideaId, spec, parentId?)` | `mergeAdd` | `PlanWriteResult` |

Erros: a promise rejeita com `Error(message)` em pt-BR (o preload tira o prefixo do Electron); o `code` não atravessa o IPC — a UI trata pela mensagem.
Para "apagar nó ticketado pede confirmação": chame `deleteNode(ideaId, id)`, e se rejeitar, ou antes disso olhe `devopsId` na subárvore
(`collectSubtree` de `@shared/plan`) → diálogo → `deleteNode(ideaId, id, true)`.

## Evento

Depois de **toda** mutação (inclusive as do Claude) o main envia `events:dataChanged` a todas as janelas com `{ entity: 'plan', ideaId }`
(`notifyPlanChanged(ideaId)` em `src/main/events.ts`). Na UI: `window.api.onDataChanged(e => { if (e.entity === 'plan' && e.ideaId === ideaId) refetch() })`
com `plan.getGraph(ideaId)`. `useAppData` ignora `plan` (nada a mudar nele). Não há evento ao apagar a ideia (o evento `ideas` já cobre).

## Códigos de erro (`PlanErrorCode` em `src/shared/plan.ts`)

`not_found`, `cross_idea`, `invalid_title`, `invalid_input`, `story_needs_project`, `project_not_linked`, `story_has_parent`, `task_needs_parent`,
`task_project_derived`, `hierarchy_cycle`, `dep_self`, `dep_duplicate`, `dep_cycle`, `project_in_use`, `ticketed_nodes`, `spec_invalid`.

## Helpers puros (`@shared/plan`)

`topoOrderHierarchy(nodes)` (pais antes dos filhos; lança `hierarchy_cycle`), `buildChildrenIndex`, `collectSubtree(nodes, rootId)` (raiz + descendentes, pré-ordem),
`isDescendant`, `wouldCreateHierarchyCycle(nodes, nodeId, newParentId)`, `findRootId`, `findRootStory`, `resolvePlanNodes(raw)`,
`findDepCycle(deps)` (caminho fechado `[a,b,a]` ou `null`), `wouldCreateDepCycle(deps, from, to)` (caminho `[from,to,…,from]` ou `null`) — use no
renderer para barrar o arraste de uma aresta antes de chamar o IPC —, e `topoOrderDeps(ids, deps)` (pré-requisitos primeiro: para "from depende de to", `to` vem antes;
estável; lança `dep_cycle`). **Fase 5**: crie os work items na ordem de `topoOrderHierarchy` e depois ligue as dependências; `topoOrderDeps` serve para ordenar execução/relato.
