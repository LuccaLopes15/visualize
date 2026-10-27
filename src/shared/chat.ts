// Fase 3: chat with the user's Claude Code CLI inside a workspace.
// Shared by main (runner, persistence), preload and renderer (chat panel).

export type ChatRole = 'user' | 'assistant'

export type ToolStatus = 'running' | 'ok' | 'error'

export interface ChatToolBlock {
  type: 'tool'
  /** tool_use id from the CLI. */
  id: string
  /** Raw tool name, e.g. `Read` or `mcp__visualize__board_add_flow`. */
  name: string
  /** Friendly pt-BR label, e.g. "Desenhando fluxo no board". */
  label: string
  /** Short summary of the input (file path, pattern, flow title...). */
  summary: string
  status: ToolStatus
  error?: string
}

export interface ChatTextBlock {
  type: 'text'
  text: string
}

export type ChatBlock = ChatTextBlock | ChatToolBlock

export interface ChatTurnMeta {
  durationMs?: number
  /** Cost of this turn in USD, when the CLI reports it. */
  costUsd?: number
  /** User pressed Stop (or the turn was cut short). */
  interrupted?: boolean
  /** Turn ended with an error (shown under the message). */
  error?: string
}

export interface ChatMessage {
  id: number
  ideaId: number
  role: ChatRole
  blocks: ChatBlock[]
  meta?: ChatTurnMeta
  createdAt: number
}

export type ClaudeErrorCode =
  | 'not_found'
  | 'too_old'
  | 'not_logged_in'
  | 'crash'
  | 'spawn'
  | 'folder_missing'
  | 'busy'
  | 'other'

export interface ClaudeError {
  code: ClaudeErrorCode
  message: string
}

/** Result of detecting the installed Claude Code CLI (Configurações + chat panel). */
export interface ClaudeStatus {
  found: boolean
  /** Executable actually spawned (claude.exe, or cli.js run with node). */
  path: string | null
  /** Where the executable came from. */
  source: 'setting' | 'path' | 'known' | null
  version: string | null
  /** False when the version is older than CLAUDE_MIN_VERSION. */
  versionOk: boolean
  /** null = could not tell (old CLI without `auth status`). */
  loggedIn: boolean | null
  /** e.g. "Claude Max · user@example.com". */
  account: string | null
  /** Actionable pt-BR explanation when something is wrong. */
  problem: ClaudeError | null
  checkedAt: number
}

export const CLAUDE_MIN_VERSION = '2.0.0'

export interface ClaudeSettings {
  /** Override for the executable; '' = auto-detect (PATH / known locations). */
  claudePath: string
  /** Model alias or full name; '' = CLI default. */
  claudeModel: string
}

export interface ChatState {
  messages: ChatMessage[]
  /** A turn is running right now (e.g. reopened the workspace mid-answer). */
  busy: boolean
  status: ClaudeStatus
}

/** Streaming events pushed to the workspace while a turn runs. */
export type ChatEvent =
  | { ideaId: number; kind: 'userMessage'; message: ChatMessage }
  | { ideaId: number; kind: 'textDelta'; text: string }
  | { ideaId: number; kind: 'toolStart'; tool: ChatToolBlock }
  | { ideaId: number; kind: 'toolEnd'; id: string; ok: boolean; error?: string }
  /** Turn finished; the assistant message is persisted (also after Stop / errors). */
  | { ideaId: number; kind: 'assistantMessage'; message: ChatMessage }
  | { ideaId: number; kind: 'busy'; busy: boolean }
  | { ideaId: number; kind: 'error'; error: ClaudeError }
  /** History cleared ("Nova conversa"). */
  | { ideaId: number; kind: 'reset' }

// ---- tool labels ------------------------------------------------------------

export const MCP_PREFIX = 'mcp__visualize__'

const TOOL_LABELS: Record<string, string> = {
  Read: 'Lendo arquivo',
  Glob: 'Procurando arquivos',
  Grep: 'Buscando no código',
  board_read: 'Olhando o board',
  board_add: 'Desenhando no board',
  board_add_flow: 'Desenhando fluxo no board',
  board_update: 'Ajustando o board',
  board_delete: 'Apagando do board',
  macro_read: 'Lendo o plano macro',
  macro_write: 'Escrevendo o plano macro',
  macro_append_section: 'Acrescentando ao plano macro'
}

/** Kind of icon the chip shows. */
export function toolKind(name: string): 'board' | 'macro' | 'read' | 'search' | 'other' {
  const n = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name
  if (n.startsWith('board_')) return 'board'
  if (n.startsWith('macro_')) return 'macro'
  if (n === 'Read') return 'read'
  if (n === 'Glob' || n === 'Grep') return 'search'
  return 'other'
}

function clip(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/** Path shown relative to one of the project folders when possible. */
function shortPath(p: string, roots: string[]): string {
  const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const np = norm(p)
  for (const r of roots) {
    const nr = norm(r)
    if (nr && np.toLowerCase().startsWith(nr.toLowerCase() + '/')) return np.slice(nr.length + 1)
  }
  return np
}

/** Friendly label + short input summary for a tool call. */
export function describeTool(
  name: string,
  input: unknown,
  roots: string[] = []
): { label: string; summary: string } {
  const short = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name
  const label = TOOL_LABELS[short] ?? (name.startsWith('mcp__') ? `Usando ${short}` : `Usando ${name}`)
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const count = (k: string): number => (Array.isArray(i[k]) ? (i[k] as unknown[]).length : 0)
  let summary = ''
  switch (short) {
    case 'Read':
      summary = shortPath(str('file_path'), roots)
      break
    case 'Glob':
      summary = str('pattern')
      break
    case 'Grep':
      summary = str('pattern') + (str('glob') ? ` em ${str('glob')}` : '')
      break
    case 'board_add': {
      const n = count('elements')
      summary = n ? `${n} elemento${n === 1 ? '' : 's'}` : ''
      break
    }
    case 'board_add_flow': {
      const n = count('nodes')
      summary = str('title') || (n ? `${n} etapa${n === 1 ? '' : 's'}` : '')
      break
    }
    case 'board_update': {
      const n = count('updates')
      summary = n ? `${n} elemento${n === 1 ? '' : 's'}` : ''
      break
    }
    case 'board_delete': {
      const n = count('ids')
      summary = n ? `${n} elemento${n === 1 ? '' : 's'}` : ''
      break
    }
    case 'macro_append_section':
      summary = str('heading')
      break
  }
  return { label, summary: clip(summary) }
}

/** Compares dotted versions ("2.1.311" vs "2.0.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const d = (pa[k] ?? 0) - (pb[k] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}
