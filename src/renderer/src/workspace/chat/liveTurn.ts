// Pure accumulation of a streaming assistant turn (mirrors ChatSession in main).
import type { ChatBlock, ChatEvent } from '@shared/chat'

export interface LiveTurn {
  blocks: ChatBlock[]
}

/** Pure reducer for streaming events (exported for tests / reuse). */
export function applyLiveEvent(live: LiveTurn | null, ev: ChatEvent): LiveTurn | null {
  switch (ev.kind) {
    case 'userMessage':
      return { blocks: [] }
    case 'textDelta': {
      const blocks = [...(live?.blocks ?? [])]
      const last = blocks.at(-1)
      if (last?.type === 'text') blocks[blocks.length - 1] = { ...last, text: last.text + ev.text }
      else blocks.push({ type: 'text', text: ev.text })
      return { blocks }
    }
    case 'toolStart':
      return { blocks: [...(live?.blocks ?? []), ev.tool] }
    case 'toolEnd':
      return {
        blocks: (live?.blocks ?? []).map((b) =>
          b.type === 'tool' && b.id === ev.id ? { ...b, status: ev.ok ? 'ok' : 'error', error: ev.error } : b
        )
      }
    case 'assistantMessage':
    case 'reset':
      return null
    default:
      return live
  }
}

