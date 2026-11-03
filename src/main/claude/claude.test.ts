import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NdjsonParser } from './ndjson'
import { CliEventNormalizer, isAuthError } from './normalize'
import { buildClaudeArgs, buildSystemPrompt, contextSignature, interruptLine, userMessageLine } from './args'
import { cleanClaudeEnv } from './env'
import { parseAuthStatus, parseShimTarget, parseVersion } from './resolve'
import { ChatSession } from './session'
import { createRepositories } from '../db'
import { compareVersions, describeTool, toolKind, type ChatEvent } from '@shared/chat'

describe('NdjsonParser', () => {
  it('handles lines split across chunks and CRLF', () => {
    const out: unknown[] = []
    const p = new NdjsonParser((v) => out.push(v))
    p.push('{"a":1}\n{"b"')
    p.push(':2}\r\n\n{"c":3}')
    expect(out).toEqual([{ a: 1 }, { b: 2 }])
    p.end()
    expect(out).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })

  it('reassembles multi-byte UTF-8 split between chunks', () => {
    const out: Record<string, unknown>[] = []
    const p = new NdjsonParser((v) => out.push(v))
    const bytes = Buffer.from('{"t":"ação 🖊 ok"}\n', 'utf8')
    // Split inside "ç" (2 bytes) and inside the emoji (4 bytes).
    const cuts = [7, 8, 14, 16, 17]
    let prev = 0
    for (const c of [...cuts, bytes.length]) {
      p.push(bytes.subarray(prev, c))
      prev = c
    }
    expect(out).toEqual([{ t: 'ação 🖊 ok' }])
  })

  it('reports malformed lines and non-objects without throwing', () => {
    const out: unknown[] = []
    const bad: string[] = []
    const p = new NdjsonParser(
      (v) => out.push(v),
      (line) => bad.push(line)
    )
    p.push('not json\n[1,2]\n{"ok":true}\n42\n')
    expect(out).toEqual([{ ok: true }])
    expect(bad).toEqual(['not json', '[1,2]', '42'])
  })
})

describe('CliEventNormalizer', () => {
  const n = (): CliEventNormalizer => new CliEventNormalizer()

  it('maps init, text deltas, tool use/result and result', () => {
    const norm = n()
    const events = [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: ['Read', 'mcp__visualize__board_read'] },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Olá' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Olá' }] } }, // duplicate of the deltas
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:/p/a.ts' } }] }
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }] } },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'denied' }] }]
        }
      },
      { type: 'rate_limit_event' },
      { type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, total_cost_usd: 0.01, result: 'Olá' }
    ].flatMap((e) => norm.normalize(e))
    expect(events).toEqual([
      { kind: 'init', sessionId: 's1', model: 'm', tools: ['Read', 'mcp__visualize__board_read'] },
      { kind: 'textBreak' },
      { kind: 'textDelta', text: 'Olá' },
      { kind: 'toolStart', id: 'tu1', name: 'Read', input: { file_path: 'C:/p/a.ts' } },
      { kind: 'toolEnd', id: 'tu1', isError: false },
      { kind: 'toolEnd', id: 'tu2', isError: true, errorText: 'denied' },
      {
        kind: 'result',
        subtype: 'success',
        isError: false,
        durationMs: 1200,
        totalCostUsd: 0.01,
        text: 'Olá',
        sessionId: undefined
      }
    ])
  })

  it('uses full assistant text when there were no partial messages', () => {
    const norm = n()
    expect(norm.normalize({ type: 'assistant', message: { content: [{ type: 'text', text: 'oi' }] } })).toEqual([
      { kind: 'textBreak' },
      { kind: 'textDelta', text: 'oi' }
    ])
  })

  it('detects auth errors and interrupted turns', () => {
    const norm = n()
    const [api] = norm.normalize({
      type: 'assistant',
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }
    })
    expect(api).toEqual({ kind: 'apiError', code: 'authentication_failed', text: 'Not logged in · Please run /login' })
    expect(isAuthError('', 'Not logged in · Please run /login')).toBe(true)
    expect(isAuthError('rate_limit', 'slow down')).toBe(false)
    const [res] = norm.normalize({ type: 'result', subtype: 'error_during_execution', is_error: false })
    expect(res).toMatchObject({ kind: 'result', isError: true })
  })

  it('ignores sub-agent events and maps control responses', () => {
    const norm = n()
    expect(norm.normalize({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [] } })).toEqual([])
    expect(
      norm.normalize({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } })
    ).toEqual([{ kind: 'controlResponse', requestId: 'r1', ok: true }])
  })
})

describe('args & env', () => {
  const ctx = {
    title: 'Ideia X',
    body: 'corpo',
    projects: [
      { name: 'App', folderPath: 'C:\\proj dir\\app', isPrimary: true },
      { name: 'Lib', folderPath: 'C:\\lib', isPrimary: false }
    ]
  }

  it('builds read-only headless args with the MCP server', () => {
    const args = buildClaudeArgs({
      mcpUrl: 'http://127.0.0.1:5555/mcp',
      mcpToken: 'tok',
      systemPrompt: buildSystemPrompt(ctx),
      addDirs: ['C:\\lib'],
      model: 'sonnet',
      resumeSessionId: 'abc'
    })
    const val = (flag: string): string => args[args.indexOf(flag) + 1]
    expect(args).toContain('-p')
    expect(val('--input-format')).toBe('stream-json')
    expect(val('--output-format')).toBe('stream-json')
    expect(val('--tools')).toBe('Read,Glob,Grep')
    const allowed = val('--allowedTools').split(',')
    expect(allowed.slice(0, 3)).toEqual(['Read', 'Glob', 'Grep'])
    for (const t of [
      'tasks_read',
      'tasks_replace_all',
      'tasks_add',
      'tasks_update_node',
      'tasks_set_parent',
      'tasks_reorder',
      'tasks_add_dep',
      'tasks_remove_dep',
      'tasks_delete_node',
      'macro_read',
      'board_add_flow'
    ]) {
      expect(allowed).toContain(`mcp__visualize__${t}`)
    }
    // Read-only guarantee: nothing that writes files or runs commands is allowed.
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Task']) {
      expect(allowed).not.toContain(t)
      expect(val('--disallowedTools').split(',')).toContain(t)
    }
    expect(allowed.every((t) => t.startsWith('mcp__visualize__') || ['Read', 'Glob', 'Grep'].includes(t))).toBe(true)
    expect(val('--tools')).not.toMatch(/Edit|Write|Bash/)
    expect(val('--setting-sources')).toBe('project')
    expect(val('--permission-mode')).toBe('dontAsk')
    expect(args).toContain('--strict-mcp-config')
    expect(JSON.parse(val('--mcp-config'))).toEqual({
      mcpServers: {
        visualize: { type: 'http', url: 'http://127.0.0.1:5555/mcp', headers: { Authorization: 'Bearer tok' } }
      }
    })
    expect(val('--add-dir')).toBe('C:\\lib')
    expect(val('--resume')).toBe('abc')
    expect(val('--model')).toBe('sonnet')
    expect(val('--append-system-prompt')).toContain('Ideia: "Ideia X"')
    expect(val('--append-system-prompt')).toContain('App (principal')
  })

  it('omits optional flags and changes the signature when context changes', () => {
    const args = buildClaudeArgs({ mcpUrl: 'u', mcpToken: 't', systemPrompt: 's', addDirs: [] })
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--add-dir')
    expect(contextSignature(ctx)).not.toBe(contextSignature({ ...ctx, title: 'Outra' }))
  })

  it('writes stream-json lines', () => {
    expect(JSON.parse(userMessageLine('oi'))).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'oi' }] }
    })
    expect(JSON.parse(interruptLine('r'))).toEqual({
      type: 'control_request',
      request_id: 'r',
      request: { subtype: 'interrupt' }
    })
  })

  it('strips inherited Claude Code session variables but keeps credentials', () => {
    const env = cleanClaudeEnv({
      PATH: 'x',
      CLAUDECODE: '1',
      CLAUDE_CODE_COORDINATOR_MODE: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep',
      CLAUDE_AGENT_SDK_VERSION: '1',
      MCP_CONNECTION_NONBLOCKING: 'true',
      ANTHROPIC_API_KEY: 'k'
    })
    expect(env).toEqual({ PATH: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'keep', ANTHROPIC_API_KEY: 'k' })
  })
})

describe('resolve helpers', () => {
  it('finds the exe behind an npm .cmd shim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vz-shim-'))
    const bin = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'claude.exe'), '')
    const shim = join(dir, 'claude.cmd')
    const content = '@ECHO off\r\nGOTO start\r\n:start\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
    expect(parseShimTarget(shim, content)).toBe(join(bin, 'claude.exe'))
    expect(parseShimTarget(shim, 'exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"')).toBe(
      join(bin, 'claude.exe')
    )
    expect(parseShimTarget(shim, 'nothing here')).toBeNull()
  })

  it('parses version and auth status', () => {
    expect(parseVersion('2.1.311 (Claude Code)\n')).toBe('2.1.311')
    expect(parseVersion('garbage')).toBeNull()
    expect(compareVersions('2.1.311', '2.0.0')).toBe(1)
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1)
    expect(parseAuthStatus('{"loggedIn":true,"subscriptionType":"max","email":"a@b.c"}')).toEqual({
      loggedIn: true,
      account: 'Claude Max · a@b.c'
    })
    expect(parseAuthStatus('{"loggedIn":false}').loggedIn).toBe(false)
    expect(parseAuthStatus('Unknown command').loggedIn).toBeNull()
  })

  it('describes tools in pt-BR with short paths', () => {
    expect(describeTool('Read', { file_path: 'C:\\proj\\src\\a.ts' }, ['C:\\proj'])).toEqual({
      label: 'Lendo arquivo',
      summary: 'src/a.ts'
    })
    expect(describeTool('mcp__visualize__board_add_flow', { title: 'Captura', nodes: [1, 2] }).label).toBe(
      'Desenhando fluxo no board'
    )
    expect(describeTool('mcp__visualize__board_add_flow', { nodes: [1, 2] }).summary).toBe('2 etapas')
  })

  it('has friendly pt-BR chips for the tasks_* tools', () => {
    const label = (n: string, input: unknown = {}): string => describeTool(`mcp__visualize__${n}`, input).label
    expect(label('tasks_read')).toBe('Lendo as tarefas')
    expect(label('tasks_replace_all')).toBe('Montando as tarefas')
    expect(label('tasks_add')).toBe('Adicionando tarefas')
    expect(label('tasks_update_node')).toBe('Atualizando tarefa')
    expect(label('tasks_set_parent')).toBe('Movendo tarefa')
    expect(label('tasks_reorder')).toBe('Reordenando tarefas')
    expect(label('tasks_add_dep')).toBe('Ligando dependência')
    expect(label('tasks_remove_dep')).toBe('Removendo dependência')
    expect(label('tasks_delete_node')).toBe('Apagando tarefa')
    expect(describeTool('mcp__visualize__tasks_replace_all', { stories: [{}, {}] }).summary).toBe('2 stories')
    expect(describeTool('mcp__visualize__tasks_add', { nodes: [{}] }).summary).toBe('1 item')
    expect(describeTool('mcp__visualize__tasks_add_dep', { deps: [{}, {}] }).summary).toBe('2 dependências')
    expect(describeTool('mcp__visualize__tasks_update_node', { title: 'Novo' }).summary).toBe('Novo')
    expect(toolKind('mcp__visualize__tasks_read')).toBe('tasks')
  })

  it('tells Claude how to break the plan into tasks', () => {
    const p = buildSystemPrompt({ title: 'T', body: '', projects: [] })
    expect(p).toContain('tasks_replace_all')
    expect(p).toContain('UMA story por projeto')
    expect(p).toContain('aba Tarefas')
    expect(p).toContain('Nunca escreva ids de nós')
  })
})

// ---- ChatSession with a fake CLI process -------------------------------------------

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = undefined
  killed = false
  written: string[] = []
  constructor() {
    super()
    this.stdin.on('data', (d: Buffer) => this.written.push(d.toString()))
  }
  kill(): boolean {
    this.killed = true
    setImmediate(() => this.emit('exit', null))
    return true
  }
  emitLine(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + '\n')
  }
}

function setup() {
  const repos = createRepositories(':memory:')
  const folder = mkdtempSync(join(tmpdir(), 'vz-proj-'))
  const idea = repos.ideas.create({ title: 'Ideia' })
  const events: ChatEvent[] = []
  const children: FakeChild[] = []
  const spawnArgs: string[][] = []
  const tokens: string[] = []
  const session = new ChatSession({
    ideaId: idea.id,
    repo: repos.chat,
    getContext: () => ({ title: 'Ideia', body: '', projects: [{ name: 'P', folderPath: folder, isPrimary: true }] }),
    getExecutable: async () => ({ command: 'claude.exe', prefixArgs: [], env: {}, display: 'claude.exe', source: 'path' }),
    model: () => '',
    mcp: { url: () => 'http://127.0.0.1:1/mcp', issueToken: () => (tokens.push('t'), 't'), revokeToken: () => tokens.pop() },
    emit: (e) => events.push(e),
    spawnFn: ((_cmd: string, args: string[]) => {
      spawnArgs.push(args)
      const c = new FakeChild()
      children.push(c)
      return c
    }) as never,
    interruptTimeoutMs: 50
  })
  return { repos, idea, session, events, children, spawnArgs, tokens }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('ChatSession', () => {
  it('streams a turn, persists messages and saves the CLI session id', async () => {
    const { repos, idea, session, events, children, spawnArgs } = setup()
    await session.send('desenha o fluxo')
    const child = children[0]
    expect(spawnArgs[0]).not.toContain('--resume')
    expect(JSON.parse(child.written[0]).message.content[0].text).toBe('desenha o fluxo')
    child.emitLine({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] })
    child.emitLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Vou ' } } })
    child.emitLine({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__visualize__board_add_flow', input: { title: 'F' } }] }
    })
    child.emitLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
    child.emitLine({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } })
    child.emitLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Pronto.' } } })
    child.emitLine({ type: 'result', subtype: 'success', duration_ms: 900, total_cost_usd: 0.02 })
    await tick()
    expect(session.busy).toBe(false)
    expect(repos.chat.getSession(idea.id)?.cliSessionId).toBe('sess-1')
    const msgs = repos.chat.listMessages(idea.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].blocks).toEqual([
      { type: 'text', text: 'Vou' },
      expect.objectContaining({ type: 'tool', id: 't1', status: 'ok', label: 'Desenhando fluxo no board', summary: 'F' }),
      { type: 'text', text: 'Pronto.' }
    ])
    expect(msgs[1].meta).toEqual({ durationMs: 900, costUsd: 0.02 })
    expect(events.map((e) => e.kind)).toEqual([
      'userMessage',
      'busy',
      'textDelta',
      'toolStart',
      'toolEnd',
      'textDelta',
      'assistantMessage',
      'busy'
    ])
  })

  it('resumes the saved session in a new process and interrupts', async () => {
    const { repos, idea, session, children, spawnArgs } = setup()
    repos.chat.setSession(idea.id, 'old-sess', 'stale-sig')
    await session.send('oi de novo')
    expect(spawnArgs[0]).toContain('--resume')
    expect(spawnArgs[0][spawnArgs[0].indexOf('--resume') + 1]).toBe('old-sess')
    // Context changed since Claude last saw it: the message carries a note.
    expect(JSON.parse(children[0].written[0]).message.content[0].text).toMatch(/^\[Contexto da ideia atualizado/)
    session.interrupt()
    expect(JSON.parse(children[0].written[1])).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
    children[0].emitLine({ type: 'result', subtype: 'error_during_execution', is_error: false })
    await tick()
    const last = repos.chat.listMessages(idea.id).at(-1)!
    expect(last.meta?.interrupted).toBe(true)
    expect(session.busy).toBe(false)
  })

  it('kills the process when the interrupt is not honoured, then respawns with --resume', async () => {
    const { repos, idea, session, children, spawnArgs } = setup()
    await session.send('primeira')
    children[0].emitLine({ type: 'system', subtype: 'init', session_id: 's-9' })
    await tick()
    session.interrupt()
    await new Promise((r) => setTimeout(r, 120))
    expect(children[0].killed).toBe(true)
    expect(session.busy).toBe(false)
    expect(repos.chat.listMessages(idea.id).at(-1)?.meta?.interrupted).toBe(true)
    await session.send('segunda')
    expect(spawnArgs[1][spawnArgs[1].indexOf('--resume') + 1]).toBe('s-9')
  })

  it('reports a crash with stderr and an auth failure as not logged in', async () => {
    const { session, events, children } = setup()
    await session.send('oi')
    children[0].stderr.write('boom: something failed\n')
    await tick()
    children[0].emit('exit', 3)
    await tick()
    const err = events.find((e) => e.kind === 'error')
    expect(err).toMatchObject({ error: { code: 'crash' } })
    expect((err as { error: { message: string } }).error.message).toContain('boom')

    await session.send('de novo')
    children[1].emitLine({
      type: 'assistant',
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }
    })
    children[1].emitLine({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' })
    await tick()
    expect(events.filter((e) => e.kind === 'error').at(-1)).toMatchObject({ error: { code: 'not_logged_in' } })
  })

  it('refuses a second message while busy', async () => {
    const { session } = setup()
    await session.send('a')
    await expect(session.send('b')).rejects.toThrow(/Aguarde/)
  })
})

vi.setConfig({ testTimeout: 10_000 })
