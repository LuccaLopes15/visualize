// main → renderer bridge for Claude's board tools. The live Excalidraw scene
// belongs to the renderer, so main sends the op to the hub window and waits
// for `chat:boardReply` (or a timeout).
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IpcEvents } from '@shared/ipc'
import type { BoardOp, BoardOpResult, BoardRequest } from '@shared/board'

const pending = new Map<string, (r: BoardOpResult) => void>()

export function requestBoardOp(
  win: BrowserWindow | null,
  ideaId: number,
  op: BoardOp,
  timeoutMs = 20_000
): Promise<BoardOpResult> {
  if (!win || win.isDestroyed() || win.webContents.isCrashed()) {
    return Promise.resolve({ ok: false, text: 'O workspace desta ideia não está aberto, então o board não pode ser alterado agora.' })
  }
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve({ ok: false, text: 'O board não respondeu a tempo (o workspace pode ter sido fechado). Tente de novo.' })
    }, timeoutMs)
    pending.set(requestId, (r) => {
      clearTimeout(timer)
      pending.delete(requestId)
      resolve(r)
    })
    const req: BoardRequest = { requestId, ideaId, op }
    win.webContents.send(IpcEvents.boardRequest, req)
  })
}

export function resolveBoardReply(requestId: unknown, result: unknown): void {
  if (typeof requestId !== 'string') return
  const r = result as Partial<BoardOpResult> | null
  pending.get(requestId)?.({
    ok: r?.ok === true,
    text: typeof r?.text === 'string' ? r.text : 'Resposta inválida do board.'
  })
}
