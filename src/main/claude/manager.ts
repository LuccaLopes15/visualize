// Owns the chat sessions of open workspaces and the cached CLI detection.
import type { ChatEvent, ChatState, ClaudeSettings, ClaudeStatus } from '@shared/chat'
import type { Repositories } from '../db'
import { invalid } from '../db/errors'
import { ChatError, ChatSession, type McpAccess } from './session'
import { detectClaude, type ClaudeExecutable } from './resolve'
import type { IdeaContext } from './args'

const MAX_MESSAGE = 100_000

export class ClaudeDetector {
  private cached: (ClaudeStatus & { exe: ClaudeExecutable | null }) | null = null
  private inflight: Promise<ClaudeStatus & { exe: ClaudeExecutable | null }> | null = null

  constructor(private readonly settingPath: () => string) {}

  async status(refresh = false): Promise<ClaudeStatus & { exe: ClaudeExecutable | null }> {
    if (this.cached && !refresh) return this.cached
    if (!this.inflight) {
      this.inflight = detectClaude(this.settingPath())
        .then((s) => {
          this.cached = s
          return s
        })
        .finally(() => {
          this.inflight = null
        })
    }
    return this.inflight
  }

  invalidate(): void {
    this.cached = null
  }
}

/** Strips the internal `exe` handle before sending a status to the renderer. */
export function publicStatus(s: ClaudeStatus & { exe?: unknown }): ClaudeStatus {
  const { exe: _exe, ...rest } = s
  void _exe
  return rest
}

export interface ChatManagerDeps {
  repos: Repositories
  mcp: McpAccess
  emit: (ev: ChatEvent) => void
}

export class ChatManager {
  private readonly sessions = new Map<number, ChatSession>()
  readonly detector: ClaudeDetector

  constructor(private readonly deps: ChatManagerDeps) {
    this.detector = new ClaudeDetector(() => this.settings().claudePath)
  }

  settings(): ClaudeSettings {
    const s = this.deps.repos.settings
    const path = s.getRaw('claude_path')
    const model = s.getRaw('claude_model')
    return {
      claudePath: typeof path === 'string' ? path : '',
      claudeModel: typeof model === 'string' ? model : ''
    }
  }

  async setPath(path: string): Promise<ClaudeStatus> {
    this.deps.repos.settings.setRaw('claude_path', path.trim())
    this.detector.invalidate()
    this.restartIdle()
    return publicStatus(await this.detector.status(true))
  }

  setModel(model: string): ClaudeSettings {
    this.deps.repos.settings.setRaw('claude_model', model.trim())
    this.restartIdle()
    return this.settings()
  }

  async open(ideaId: number): Promise<ChatState> {
    this.deps.repos.ideas.get(ideaId) // throws if missing
    const status = publicStatus(await this.detector.status())
    return {
      messages: this.deps.repos.chat.listMessages(ideaId),
      busy: this.sessions.get(ideaId)?.busy ?? false,
      status
    }
  }

  async send(ideaId: number, text: string): Promise<void> {
    if (typeof text !== 'string' || !text.trim()) throw invalid('Mensagem vazia.')
    if (text.length > MAX_MESSAGE) throw invalid('Mensagem grande demais.')
    let session = this.sessions.get(ideaId)
    if (!session) {
      session = this.createSession(ideaId)
      this.sessions.set(ideaId, session)
    }
    if (session.busy) {
      throw invalid('Aguarde o Claude terminar a resposta atual (ou clique em Parar).')
    }
    await session.send(text.trim())
  }

  stop(ideaId: number): void {
    this.sessions.get(ideaId)?.interrupt()
  }

  reset(ideaId: number): void {
    this.close(ideaId)
    this.deps.repos.chat.reset(ideaId)
    this.deps.emit({ ideaId, kind: 'reset' })
  }

  /** Leaving the workspace / idea deleted: end the process, keep history. */
  close(ideaId: number): void {
    const session = this.sessions.get(ideaId)
    if (!session) return
    this.sessions.delete(ideaId)
    session.dispose()
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  /** Settings changed: idle processes are ended so the next message uses the new path/model. */
  private restartIdle(): void {
    for (const s of this.sessions.values()) if (!s.busy) s.kill()
  }

  private createSession(ideaId: number): ChatSession {
    return new ChatSession({
      ideaId,
      repo: this.deps.repos.chat,
      getContext: () => this.ideaContext(ideaId),
      getExecutable: async () => {
        const status = await this.detector.status()
        if (!status.exe || !status.found) {
          throw new ChatError(status.problem ?? { code: 'not_found', message: 'Claude Code não encontrado.' })
        }
        if (!status.versionOk) throw new ChatError(status.problem ?? { code: 'too_old', message: 'Versão antiga.' })
        if (status.loggedIn === false) {
          // Maybe the user logged in meanwhile: check again before giving up.
          const fresh = await this.detector.status(true)
          if (fresh.loggedIn === false || !fresh.exe) {
            throw new ChatError(fresh.problem ?? { code: 'not_logged_in', message: 'Claude Code não está logado.' })
          }
          return fresh.exe
        }
        return status.exe
      },
      model: () => this.settings().claudeModel,
      mcp: this.deps.mcp,
      emit: this.deps.emit,
      onSpawnFailure: () => this.detector.invalidate()
    })
  }

  private ideaContext(ideaId: number): IdeaContext {
    const { ideas, projects } = this.deps.repos
    const idea = ideas.get(ideaId)
    const all = new Map(projects.list().map((p) => [p.id, p]))
    return {
      title: idea.title,
      body: idea.body,
      projects: idea.projects
        .map((l) => {
          const p = all.get(l.projectId)
          return p ? { name: p.name, folderPath: p.folderPath, isPrimary: l.isPrimary } : null
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
    }
  }
}
