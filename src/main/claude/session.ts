// One long-lived headless Claude Code process per open workspace (see
// docs/spike-fase3.md for why). User messages go in as stream-json lines; the
// stdout NDJSON is normalized into ChatEvents for the renderer and the
// finished turn is persisted. The CLI session id is saved on every `init`, so
// a later process (app restarted, crash, workspace reopened) continues the
// same conversation with `--resume`.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  describeTool,
  type ChatBlock,
  type ChatEvent,
  type ChatToolBlock,
  type ChatTurnMeta,
  type ClaudeError
} from '@shared/chat'
import type { ChatRepository } from '../db/repositories/chat'
import { NdjsonParser } from './ndjson'
import { CliEventNormalizer, isAuthError, type CliEvent } from './normalize'
import {
  buildClaudeArgs,
  buildSystemPrompt,
  contextSignature,
  contextUpdateNote,
  interruptLine,
  userMessageLine,
  type IdeaContext
} from './args'
import { cleanClaudeEnv } from './env'
import type { ClaudeExecutable } from './resolve'

export class ChatError extends Error {
  constructor(public readonly detail: ClaudeError) {
    super(detail.message)
    this.name = 'ChatError'
  }
}

export interface McpAccess {
  url: () => string
  /** Issues a Bearer token scoped to this idea (tools can only touch it). */
  issueToken: (ideaId: number) => string
  revokeToken: (token: string) => void
}

export interface SessionDeps {
  ideaId: number
  repo: ChatRepository
  /** Current idea context; throws ChatError when it can't run (no primary folder…). */
  getContext: () => IdeaContext
  /** Resolved CLI executable; throws ChatError (not found / too old). */
  getExecutable: () => Promise<ClaudeExecutable>
  model: () => string
  mcp: McpAccess
  emit: (ev: ChatEvent) => void
  /** Called when the process failed in a way that suggests re-detecting the CLI. */
  onSpawnFailure?: () => void
  /** For tests. */
  spawnFn?: typeof spawn
  interruptTimeoutMs?: number
}

interface Turn {
  blocks: ChatBlock[]
  startedAt: number
  error?: string
  /** User text, kept to retry once if `--resume` fails. */
  userText: string
  retried: boolean
}

const STDERR_KEEP = 8 * 1024

export class ChatSession {
  private proc: ChildProcessWithoutNullStreams | null = null
  private token: string | null = null
  private turn: Turn | null = null
  private _busy = false
  private stderr = ''
  private sawInit = false
  private spawnedWithResume = false
  private killedByUs = false
  private interruptRequested = false
  private interruptTimer: NodeJS.Timeout | null = null
  private lastTotalCost = 0
  private disposed = false
  private readonly roots: string[] = []

  constructor(private readonly deps: SessionDeps) {}

  get busy(): boolean {
    return this._busy
  }

  get ideaId(): number {
    return this.deps.ideaId
  }

  /** Persists the user message and starts a turn. */
  async send(text: string): Promise<void> {
    if (this.disposed) throw new ChatError({ code: 'other', message: 'Sessão encerrada.' })
    if (this._busy) {
      throw new ChatError({ code: 'busy', message: 'Aguarde o Claude terminar a resposta atual (ou clique em Parar).' })
    }
    const { ideaId, repo, emit } = this.deps
    const userMessage = repo.addMessage(ideaId, 'user', [{ type: 'text', text }])
    emit({ ideaId, kind: 'userMessage', message: userMessage })
    this.setBusy(true)
    this.turn = { blocks: [], startedAt: Date.now(), userText: text, retried: false }
    this.interruptRequested = false
    try {
      await this.deliver(text)
    } catch (err) {
      const detail =
        err instanceof ChatError ? err.detail : { code: 'other' as const, message: errorMessage(err) }
      this.deps.emit({ ideaId, kind: 'error', error: detail })
      this.finishTurn({ error: detail.message })
    }
  }

  /** Spawns (or reuses) the process and writes the message line. */
  private async deliver(text: string): Promise<void> {
    const ctx = this.deps.getContext()
    const sig = contextSignature(ctx)
    const freshProcess = !this.proc
    if (freshProcess) await this.start(ctx)
    if (this.interruptRequested || !this.turn) return // stopped while spawning
    let line = text
    const session = this.deps.repo.getSession(this.deps.ideaId)
    // A new process without --resume got the current context in its system
    // prompt. Otherwise Claude may have an older one (the CLI snapshots the
    // system prompt per conversation): tell it what changed.
    if (!(freshProcess && !this.spawnedWithResume) && session?.contextSig !== sig) {
      line = contextUpdateNote(ctx) + text
    }
    this.deps.repo.setContextSig(this.deps.ideaId, sig)
    this.write(userMessageLine(line))
  }

  private async start(ctx: IdeaContext): Promise<void> {
    const exe = await this.deps.getExecutable()
    if (!this.turn || this.interruptRequested || this.disposed) return // stopped meanwhile
    const primary = ctx.projects.find((p) => p.isPrimary) ?? ctx.projects[0]
    if (!primary) {
      throw new ChatError({ code: 'folder_missing', message: 'Vincule um projeto à ideia para conversar com o Claude.' })
    }
    if (!existsSync(primary.folderPath)) {
      throw new ChatError({
        code: 'folder_missing',
        message: `A pasta do projeto principal não existe: ${primary.folderPath}. Corrija o projeto "${primary.name}" no hub.`
      })
    }
    const addDirs = ctx.projects
      .filter((p) => p !== primary && p.folderPath !== primary.folderPath && existsSync(p.folderPath))
      .map((p) => p.folderPath)
    this.roots.splice(0, this.roots.length, primary.folderPath, ...addDirs)

    const resume = this.deps.repo.getSession(this.deps.ideaId)?.cliSessionId ?? null
    this.token = this.deps.mcp.issueToken(this.deps.ideaId)
    const args = buildClaudeArgs({
      mcpUrl: this.deps.mcp.url(),
      mcpToken: this.token,
      systemPrompt: buildSystemPrompt(ctx),
      addDirs,
      model: this.deps.model(),
      resumeSessionId: resume
    })
    const spawnFn = this.deps.spawnFn ?? spawn
    const child = spawnFn(exe.command, [...exe.prefixArgs, ...args], {
      cwd: primary.folderPath,
      env: { ...cleanClaudeEnv(), ...exe.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
    this.proc = child
    this.stderr = ''
    this.sawInit = false
    this.spawnedWithResume = !!resume
    this.killedByUs = false
    this.lastTotalCost = 0

    const normalizer = new CliEventNormalizer()
    const parser = new NdjsonParser(
      (value) => {
        for (const ev of normalizer.normalize(value)) this.onCliEvent(ev)
      },
      (line) => console.warn('[claude] linha não-JSON:', line.slice(0, 200))
    )
    child.stdout.on('data', (chunk: Buffer) => parser.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_KEEP)
    })
    child.stdin.on('error', () => {
      /* process died; 'exit' handles it */
    })
    child.on('error', (err) => {
      console.error('[claude] spawn error', err)
      if (this.proc === child) this.onExit(child, null, err)
    })
    child.on('exit', (code) => {
      parser.end()
      if (this.proc === child) this.onExit(child, code)
    })
    console.log(`[claude] idea ${this.deps.ideaId}: pid ${child.pid}${resume ? ` --resume ${resume}` : ''}`)
  }

  private write(line: string): void {
    if (!this.proc || this.proc.stdin.destroyed) {
      throw new ChatError({ code: 'crash', message: 'O processo do Claude não está rodando.' })
    }
    this.proc.stdin.write(line)
  }

  private onCliEvent(ev: CliEvent): void {
    const { ideaId, emit, repo } = this.deps
    switch (ev.kind) {
      case 'init': {
        this.sawInit = true
        const current = repo.getSession(ideaId)
        if (current?.cliSessionId !== ev.sessionId) repo.setSession(ideaId, ev.sessionId)
        return
      }
      case 'textBreak': {
        const last = this.turn?.blocks.at(-1)
        if (last?.type === 'text' && last.text.trim()) this.appendText('\n\n')
        return
      }
      case 'textDelta':
        this.appendText(ev.text)
        return
      case 'toolStart': {
        if (!this.turn) return
        const { label, summary } = describeTool(ev.name, ev.input, this.roots)
        const tool: ChatToolBlock = { type: 'tool', id: ev.id, name: ev.name, label, summary, status: 'running' }
        this.turn.blocks.push(tool)
        emit({ ideaId, kind: 'toolStart', tool: { ...tool } })
        return
      }
      case 'toolEnd': {
        const tool = this.turn?.blocks.find((b): b is ChatToolBlock => b.type === 'tool' && b.id === ev.id)
        if (!tool) return
        tool.status = ev.isError ? 'error' : 'ok'
        if (ev.isError && ev.errorText) tool.error = ev.errorText
        emit({ ideaId, kind: 'toolEnd', id: ev.id, ok: !ev.isError, error: tool.error })
        return
      }
      case 'apiError': {
        if (!this.turn) return
        if (isAuthError(ev.code, ev.text)) {
          const error: ClaudeError = {
            code: 'not_logged_in',
            message: 'O Claude Code não está logado. Abra um terminal, rode "claude", faça login (/login) e tente de novo.'
          }
          this.turn.error = error.message
          emit({ ideaId, kind: 'error', error })
        } else {
          this.turn.error = ev.text || `Erro da API (${ev.code}).`
        }
        return
      }
      case 'result': {
        const meta: ChatTurnMeta = {}
        if (ev.durationMs !== undefined) meta.durationMs = ev.durationMs
        if (ev.totalCostUsd !== undefined) {
          const delta = ev.totalCostUsd - this.lastTotalCost
          this.lastTotalCost = ev.totalCostUsd
          if (delta > 0) meta.costUsd = delta
        }
        if (this.interruptRequested) meta.interrupted = true
        else if (this.turn?.error) meta.error = this.turn.error
        else if (ev.isError) meta.error = ev.text?.trim() || `O Claude terminou com erro (${ev.subtype}).`
        this.finishTurn(meta)
        return
      }
      case 'controlResponse':
        if (!ev.ok) console.warn('[claude] control_request falhou:', ev.error)
        return
    }
  }

  private appendText(text: string): void {
    if (!this.turn) return
    const last = this.turn.blocks.at(-1)
    if (last?.type === 'text') last.text += text
    else this.turn.blocks.push({ type: 'text', text })
    this.deps.emit({ ideaId: this.deps.ideaId, kind: 'textDelta', text })
  }

  /** Stop button: interrupts the running turn (kills the process if it doesn't obey). */
  interrupt(): void {
    if (!this._busy) return
    this.interruptRequested = true
    if (!this.proc) {
      // Still resolving / spawning: the turn ends right here.
      this.finishTurn({ interrupted: true })
      return
    }
    try {
      this.write(interruptLine(`interrupt-${randomUUID()}`))
    } catch {
      /* fall through to the timer */
    }
    if (this.interruptTimer) clearTimeout(this.interruptTimer)
    this.interruptTimer = setTimeout(() => {
      if (this._busy) {
        console.warn('[claude] interrupção não confirmada; encerrando o processo')
        this.kill()
      }
    }, this.deps.interruptTimeoutMs ?? 4000)
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null, spawnError?: Error): void {
    this.proc = null
    if (this.token) this.deps.mcp.revokeToken(this.token)
    this.token = null
    void child
    if (!this.turn) return
    if (this.killedByUs || this.interruptRequested || this.disposed) {
      this.finishTurn({ interrupted: true })
      return
    }
    const stderr = this.stderr.trim()
    // --resume of a session the CLI no longer has: start a new one, once.
    if (
      !this.sawInit &&
      this.spawnedWithResume &&
      !this.turn.retried &&
      /no conversation found|session.*not found|could not resume/i.test(stderr)
    ) {
      this.deps.repo.setSession(this.deps.ideaId, null, '')
      this.turn.retried = true
      this.appendText('_(Não foi possível retomar a conversa anterior do Claude; começando uma nova sessão.)_\n\n')
      void this.deliver(this.turn.userText).catch((err) => {
        const detail = err instanceof ChatError ? err.detail : { code: 'other' as const, message: errorMessage(err) }
        this.deps.emit({ ideaId: this.deps.ideaId, kind: 'error', error: detail })
        this.finishTurn({ error: detail.message })
      })
      return
    }
    let error: ClaudeError
    if (spawnError) {
      this.deps.onSpawnFailure?.()
      error = { code: 'spawn', message: `Não foi possível iniciar o Claude Code: ${spawnError.message}` }
    } else if (isAuthError('', stderr)) {
      error = {
        code: 'not_logged_in',
        message: 'O Claude Code não está logado. Abra um terminal, rode "claude", faça login (/login) e tente de novo.'
      }
    } else {
      const tail = stderr ? `\n${stderr.split(/\r?\n/).slice(-6).join('\n')}` : ''
      error = { code: 'crash', message: `O Claude Code encerrou inesperadamente (código ${code ?? '?'}).${tail}` }
    }
    this.deps.emit({ ideaId: this.deps.ideaId, kind: 'error', error })
    this.finishTurn({ error: error.message })
  }

  private finishTurn(meta: ChatTurnMeta): void {
    if (this.interruptTimer) clearTimeout(this.interruptTimer)
    this.interruptTimer = null
    const turn = this.turn
    this.turn = null
    if (turn) {
      const blocks = turn.blocks
        .map((b) => (b.type === 'text' ? { ...b, text: b.text.trim() } : b))
        .filter((b) => b.type !== 'text' || b.text)
        .map((b) =>
          b.type === 'tool' && b.status === 'running'
            ? { ...b, status: 'error' as const, error: meta.interrupted ? 'interrompido' : 'sem resposta' }
            : b
        )
      if (!meta.durationMs) meta.durationMs = Date.now() - turn.startedAt
      const { ideaId, repo, emit } = this.deps
      try {
        const message = repo.addMessage(ideaId, 'assistant', blocks, meta)
        emit({ ideaId, kind: 'assistantMessage', message })
      } catch (err) {
        // Idea deleted mid-turn: nothing to persist.
        console.warn('[claude] não foi possível gravar a resposta', err)
      }
    }
    this.interruptRequested = false
    this.setBusy(false)
  }

  private setBusy(busy: boolean): void {
    if (this._busy === busy) return
    this._busy = busy
    this.deps.emit({ ideaId: this.deps.ideaId, kind: 'busy', busy })
  }

  /** Ends the process (leaving the workspace, "Nova conversa", quitting, settings changed). */
  dispose(): void {
    this.disposed = true
    if (this.turn) this.interruptRequested = true
    this.kill()
    if (this.turn) this.finishTurn({ interrupted: true })
  }

  /** Kills the process but keeps the session usable (next send respawns with --resume). */
  kill(): void {
    const child = this.proc
    if (!child) return
    this.killedByUs = true
    killTree(child)
  }

  get running(): boolean {
    return this.proc !== null
  }
}

/** Kills the CLI and anything it spawned (Windows needs taskkill /T for the tree). */
export function killTree(child: { pid?: number; kill: () => boolean }): void {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
