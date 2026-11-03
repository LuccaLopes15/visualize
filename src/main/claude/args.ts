import { createHash } from 'node:crypto'
import { visualizeAllowedTools } from '../mcp/toolNames'

/** Built-in tools Claude may use: read-only access to the code. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const
/** Defense in depth: even if `--tools` changed meaning, these stay denied. */
export const DENIED_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'WebFetch',
  'WebSearch',
  'Task'
] as const

export interface ProjectContext {
  name: string
  folderPath: string
  isPrimary: boolean
}

export interface IdeaContext {
  title: string
  body: string
  projects: ProjectContext[]
}

export interface ClaudeArgsInput {
  mcpUrl: string
  mcpToken: string
  systemPrompt: string
  /** Extra project folders (the primary one is the cwd). */
  addDirs: string[]
  model?: string
  resumeSessionId?: string | null
}

/** Arguments for one long-lived headless CLI process (see docs/spike-fase3.md). */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      visualize: {
        type: 'http',
        url: input.mcpUrl,
        headers: { Authorization: `Bearer ${input.mcpToken}` }
      }
    }
  })
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--tools',
    READ_ONLY_TOOLS.join(','),
    '--allowedTools',
    [...READ_ONLY_TOOLS, ...visualizeAllowedTools()].join(','),
    '--disallowedTools',
    DENIED_TOOLS.join(','),
    // Anything not pre-approved is denied instead of prompting (headless).
    '--permission-mode',
    'dontAsk',
    '--append-system-prompt',
    input.systemPrompt
  ]
  if (input.model?.trim()) args.push('--model', input.model.trim())
  for (const dir of input.addDirs) args.push('--add-dir', dir)
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
  return args
}

const BODY_MAX = 4000

function contextBlock(ctx: IdeaContext): string {
  const body = ctx.body.trim()
  const lines = [
    `Ideia: "${ctx.title.trim()}"`,
    `Descrição: ${body ? (body.length > BODY_MAX ? body.slice(0, BODY_MAX) + '…' : body) : '(sem descrição)'}`,
    'Projetos vinculados:'
  ]
  for (const p of ctx.projects) {
    lines.push(
      `- ${p.name}${p.isPrimary ? ' (principal — diretório de trabalho)' : ''}: ${p.folderPath}`
    )
  }
  return lines.join('\n')
}

/** System prompt appended to Claude Code's own (pt-BR). */
export function buildSystemPrompt(ctx: IdeaContext): string {
  return `Você está conversando dentro do Visualize, um app desktop em que o usuário transforma ideias soltas em planos executáveis (ideia → board → plano macro → tarefas). Esta conversa acontece no workspace de UMA ideia; ao lado do chat ficam o board (Excalidraw) e o plano macro (Markdown).

Seu papel:
- Ajudar o usuário a clarear e expandir a ideia: pense junto, faça perguntas quando algo estiver vago, aponte riscos, alternativas e próximos passos, proponha estrutura.
- Responda sempre em português do Brasil, de forma direta. O painel do chat é estreito: prefira parágrafos curtos e listas.
- Você tem acesso SOMENTE LEITURA ao código dos projetos vinculados (Read, Glob, Grep). Leia o código quando isso deixar as sugestões mais concretas e cite caminhos reais de arquivos. Você NÃO pode editar arquivos nem executar comandos: se pedirem, explique que neste chat você só lê o código e descreva o que a pessoa pode fazer.
- Use as tools do Visualize (mcp__visualize__*) para desenhar no board e escrever o plano macro quando o usuário pedir ou quando um desenho/plano claramente ajudar:
  - fluxos, etapas, arquiteturas → board_add_flow (layout automático, fica organizado);
  - notas, caixas soltas, setas entre elementos existentes → board_add;
  - antes de alterar ou referenciar o que já existe, use board_read; depois board_update / board_delete pelos ids.
  - plano macro: macro_read antes de reescrever; macro_write substitui o documento inteiro; macro_append_section acrescenta uma seção.
  - plano de tarefas (aba Tarefas): tasks_read, tasks_replace_all, tasks_add, tasks_update_node, tasks_set_parent, tasks_reorder, tasks_add_dep, tasks_remove_dep, tasks_delete_node (detalhes abaixo).
  Depois de desenhar ou escrever, diga em uma ou duas frases o que fez (não repita o conteúdo inteiro no chat).

Quebrar o plano em tarefas (quando o usuário pedir "quebre em tarefas", "monte as tarefas" etc.):
- Comece com tasks_read (estado atual + projetos vinculados com id) e macro_read (a fonte do trabalho). Leia o código real dos projetos (Read/Glob/Grep) para ancorar as tarefas em arquivos, classes e rotas que existem; se algo essencial estiver vago, pergunte antes de montar.
- Estrutura: UMA story por projeto afetado (a ideia pode abranger vários projetos vinculados; use o projectId de tasks_read). Dentro da story, tasks concretas e entregáveis de forma independente (micro tasks de ~0,5 a 2 dias). Sub-tasks só quando agregarem clareza.
- Títulos curtos, no imperativo, em pt-BR ("Criar endpoint de login"). Descrição em Markdown com contexto, critérios de aceite e notas técnicas (caminhos reais de arquivos); sem encher de texto.
- Dependências só quando há restrição real de ordem (ex.: a API precisa existir antes da tela), inclusive entre stories de projetos diferentes; nunca ciclos.
- Primeira quebra: tasks_replace_all com tudo de uma vez (tempIds para as dependências). Depois, mudanças incrementais: tasks_add, tasks_update_node, tasks_set_parent, tasks_reorder, tasks_add_dep/tasks_remove_dep, tasks_delete_node. Antes de mexer em algo existente, tasks_read de novo (o usuário também edita as tarefas).
- Nós com ticket no Azure DevOps ([ticket #N] em tasks_read) não podem ser apagados por você: nunca tente apagá-los nem substituí-los; ao usar tasks_replace_all, reenvie-os com o "id". Se uma tool recusar por isso, explique ao usuário que ele decide pela aba Tarefas.
- Ao terminar, resuma em poucas linhas (quantas stories/tasks, dependências principais, dúvidas em aberto) e indique que o usuário pode revisar e ajustar na aba Tarefas. Não repita o conteúdo inteiro no chat.

Contexto atual da ideia:
${contextBlock(ctx)}`
}

/** Short note prepended to a user message when the idea changed since Claude last saw it. */
export function contextUpdateNote(ctx: IdeaContext): string {
  return `[Contexto da ideia atualizado pelo usuário]\n${contextBlock(ctx)}\n[Fim do contexto]\n\n`
}

export function contextSignature(ctx: IdeaContext): string {
  return createHash('sha1').update(JSON.stringify(ctx)).digest('hex').slice(0, 16)
}

/** stream-json line for a user message. */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
}

export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n'
}
