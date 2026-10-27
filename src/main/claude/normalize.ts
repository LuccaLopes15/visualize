// Turns raw `--output-format stream-json` events from the Claude Code CLI into
// a small, stable set of events the chat session understands. Pure (no I/O) so
// it is unit-tested against captured CLI output (see docs/spike-fase3.md).

export type CliEvent =
  | { kind: 'init'; sessionId: string; model: string; tools: string[] }
  | { kind: 'textDelta'; text: string }
  /** A new text content block started (separate it from the previous text). */
  | { kind: 'textBreak' }
  | { kind: 'toolStart'; id: string; name: string; input: unknown }
  | { kind: 'toolEnd'; id: string; isError: boolean; errorText?: string }
  /** The API call itself failed (e.g. `authentication_failed`, rate limit). */
  | { kind: 'apiError'; code: string; text: string }
  | {
      kind: 'result'
      subtype: string
      isError: boolean
      durationMs?: number
      /** Cumulative cost for the process (the CLI reports a running total). */
      totalCostUsd?: number
      text?: string
      sessionId?: string
    }
  | { kind: 'controlResponse'; requestId: string; ok: boolean; error?: string }

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c['text'] === 'string' ? (c['text'] as string) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export class CliEventNormalizer {
  /** Text deltas seen in the current turn (then full assistant text is redundant). */
  private sawDelta = false

  normalize(raw: Obj): CliEvent[] {
    // Events from sub-agents are not shown (we never enable Task anyway).
    if (raw['parent_tool_use_id']) return []
    switch (raw['type']) {
      case 'system':
        return this.system(raw)
      case 'stream_event':
        return this.streamEvent(raw['event'])
      case 'assistant':
        return this.assistant(raw)
      case 'user':
        return this.user(raw)
      case 'result':
        return this.result(raw)
      case 'control_response':
        return this.controlResponse(raw)
      default:
        return []
    }
  }

  private system(raw: Obj): CliEvent[] {
    if (raw['subtype'] !== 'init') return []
    const sessionId = str(raw['session_id'])
    if (!sessionId) return []
    const tools = Array.isArray(raw['tools']) ? raw['tools'].filter((t): t is string => typeof t === 'string') : []
    return [{ kind: 'init', sessionId, model: str(raw['model']) ?? '', tools }]
  }

  private streamEvent(ev: unknown): CliEvent[] {
    if (!isObj(ev)) return []
    if (ev['type'] === 'content_block_start') {
      const block = ev['content_block']
      return isObj(block) && block['type'] === 'text' ? [{ kind: 'textBreak' }] : []
    }
    if (ev['type'] !== 'content_block_delta') return []
    const delta = ev['delta']
    if (!isObj(delta) || delta['type'] !== 'text_delta') return []
    const text = str(delta['text'])
    if (!text) return []
    this.sawDelta = true
    return [{ kind: 'textDelta', text }]
  }

  private assistant(raw: Obj): CliEvent[] {
    const out: CliEvent[] = []
    const message = raw['message']
    const content = isObj(message) && Array.isArray(message['content']) ? message['content'] : []
    const error = str(raw['error'])
    if (error) {
      const text = content
        .map((c) => (isObj(c) && c['type'] === 'text' ? (str(c['text']) ?? '') : ''))
        .join('\n')
        .trim()
      return [{ kind: 'apiError', code: error, text }]
    }
    for (const block of content) {
      if (!isObj(block)) continue
      if (block['type'] === 'tool_use') {
        const id = str(block['id'])
        const name = str(block['name'])
        if (id && name) out.push({ kind: 'toolStart', id, name, input: block['input'] ?? {} })
      } else if (block['type'] === 'text' && !this.sawDelta) {
        // Without --include-partial-messages the whole text arrives here.
        const text = str(block['text'])
        if (text) out.push({ kind: 'textBreak' }, { kind: 'textDelta', text })
      }
    }
    return out
  }

  private user(raw: Obj): CliEvent[] {
    const message = raw['message']
    const content = isObj(message) && Array.isArray(message['content']) ? message['content'] : []
    const out: CliEvent[] = []
    for (const block of content) {
      if (!isObj(block) || block['type'] !== 'tool_result') continue
      const id = str(block['tool_use_id'])
      if (!id) continue
      const isError = block['is_error'] === true
      const ev: CliEvent = { kind: 'toolEnd', id, isError }
      if (isError) ev.errorText = toolResultText(block['content']).slice(0, 500)
      out.push(ev)
    }
    return out
  }

  private result(raw: Obj): CliEvent[] {
    this.sawDelta = false
    return [
      {
        kind: 'result',
        subtype: str(raw['subtype']) ?? '',
        isError: raw['is_error'] === true || (str(raw['subtype']) ?? '').startsWith('error'),
        durationMs: num(raw['duration_ms']),
        totalCostUsd: num(raw['total_cost_usd']),
        text: str(raw['result']),
        sessionId: str(raw['session_id'])
      }
    ]
  }

  private controlResponse(raw: Obj): CliEvent[] {
    const r = raw['response']
    if (!isObj(r)) return []
    const requestId = str(r['request_id'])
    if (!requestId) return []
    const ok = r['subtype'] === 'success'
    const ev: CliEvent = { kind: 'controlResponse', requestId, ok }
    if (!ok) ev.error = str(r['error'])
    return [ev]
  }
}

/** True when an API error / result text means the CLI is not logged in. */
export function isAuthError(code: string, text = ''): boolean {
  return (
    code === 'authentication_failed' ||
    /not logged in|please run \/login|invalid api key|oauth token (has )?expired/i.test(text)
  )
}
