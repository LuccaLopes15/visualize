import type Database from 'better-sqlite3'
import type { ChatBlock, ChatMessage, ChatRole, ChatTurnMeta } from '@shared/chat'
import { invalid, notFound } from '../errors'

interface MessageRow {
  id: number
  idea_id: number
  role: ChatRole
  content_json: string
  created_at: number
}

export interface ChatSessionRow {
  cliSessionId: string | null
  contextSig: string
  updatedAt: number
}

/** Stored per message: interleaved text/tool blocks plus turn metadata. */
interface StoredContent {
  blocks: ChatBlock[]
  meta?: ChatTurnMeta
}

/** Keeps a runaway answer from bloating the DB (~2 MB of JSON per message). */
const MAX_CONTENT = 2_000_000

/**
 * Chat history and Claude Code CLI session per idea. Both tables cascade when
 * the idea is deleted.
 */
export class ChatRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  /** Last `limit` messages of an idea, oldest first. */
  listMessages(ideaId: number, limit = 300): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (SELECT id, idea_id, role, content_json, created_at FROM chat_messages
           WHERE idea_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`
      )
      .all(ideaId, limit) as MessageRow[]
    return rows.map(toMessage)
  }

  addMessage(ideaId: number, role: ChatRole, blocks: ChatBlock[], meta?: ChatTurnMeta): ChatMessage {
    if (role !== 'user' && role !== 'assistant') throw invalid('Papel de mensagem inválido.')
    this.assertIdea(ideaId)
    const content: StoredContent = meta ? { blocks, meta } : { blocks }
    let json = JSON.stringify(content)
    if (json.length > MAX_CONTENT) {
      json = JSON.stringify({
        blocks: [{ type: 'text', text: '(mensagem grande demais para guardar no histórico)' }],
        meta
      } satisfies StoredContent)
    }
    const ts = this.now()
    const info = this.db
      .prepare('INSERT INTO chat_messages (idea_id, role, content_json, created_at) VALUES (?, ?, ?, ?)')
      .run(ideaId, role, json, ts)
    return toMessage({
      id: Number(info.lastInsertRowid),
      idea_id: ideaId,
      role,
      content_json: json,
      created_at: ts
    })
  }

  getSession(ideaId: number): ChatSessionRow | null {
    const row = this.db
      .prepare('SELECT cli_session_id, context_sig, updated_at FROM chat_sessions WHERE idea_id = ?')
      .get(ideaId) as { cli_session_id: string | null; context_sig: string; updated_at: number } | undefined
    return row
      ? { cliSessionId: row.cli_session_id, contextSig: row.context_sig, updatedAt: row.updated_at }
      : null
  }

  /** Upserts the CLI session id (and optionally the context signature Claude saw). */
  setSession(ideaId: number, cliSessionId: string | null, contextSig?: string): void {
    this.assertIdea(ideaId)
    const ts = this.now()
    const current = this.getSession(ideaId)
    this.db
      .prepare(
        `INSERT INTO chat_sessions (idea_id, cli_session_id, context_sig, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(idea_id) DO UPDATE SET cli_session_id = excluded.cli_session_id,
           context_sig = excluded.context_sig, updated_at = excluded.updated_at`
      )
      .run(ideaId, cliSessionId, contextSig ?? current?.contextSig ?? '', ts)
  }

  setContextSig(ideaId: number, contextSig: string): void {
    this.setSession(ideaId, this.getSession(ideaId)?.cliSessionId ?? null, contextSig)
  }

  /** "Nova conversa": forgets the CLI session and clears the history. */
  reset(ideaId: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM chat_messages WHERE idea_id = ?').run(ideaId)
      this.db.prepare('DELETE FROM chat_sessions WHERE idea_id = ?').run(ideaId)
    })()
  }

  private assertIdea(ideaId: number): void {
    if (!this.db.prepare('SELECT 1 FROM ideas WHERE id = ?').get(ideaId)) throw notFound('Ideia', ideaId)
  }
}

function toMessage(row: MessageRow): ChatMessage {
  let content: StoredContent
  try {
    content = JSON.parse(row.content_json) as StoredContent
    if (!Array.isArray(content.blocks)) content = { blocks: [] }
  } catch {
    content = { blocks: [{ type: 'text', text: '(mensagem ilegível)' }] }
  }
  const msg: ChatMessage = {
    id: row.id,
    ideaId: row.idea_id,
    role: row.role,
    blocks: content.blocks,
    createdAt: row.created_at
  }
  if (content.meta) msg.meta = content.meta
  return msg
}
