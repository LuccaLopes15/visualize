export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

/**
 * Debounced, serialized autosave. `schedule(v)` keeps only the latest value
 * and saves it `delay` ms after the last call; `flush()` saves right away (and
 * waits for an in-flight save first). Saves never overlap. A failed save keeps
 * its value queued so the next flush retries it.
 */
export class Autosaver<T> {
  private pending: { value: T } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> | null = null
  private _status: SaveStatus = 'idle'

  constructor(
    private readonly save: (value: T) => Promise<void>,
    private readonly delay = 800,
    private readonly onStatus?: (status: SaveStatus, error?: unknown) => void
  ) {}

  get status(): SaveStatus {
    return this._status
  }

  /** True while something is queued or being written. */
  get dirty(): boolean {
    return this.pending !== null || this.inflight !== null
  }

  schedule(value: T): void {
    this.pending = { value }
    this.setStatus('pending')
    this.clearTimer()
    this.timer = setTimeout(() => void this.flush(), this.delay)
  }

  async flush(): Promise<void> {
    this.clearTimer()
    while (this.inflight) await this.inflight
    if (!this.pending) return
    const { value } = this.pending
    this.pending = null
    this.setStatus('saving')
    this.inflight = (async () => {
      try {
        await this.save(value)
        if (!this.pending) this.setStatus('saved')
      } catch (err) {
        if (!this.pending) this.pending = { value }
        this.setStatus('error', err)
      } finally {
        this.inflight = null
      }
    })()
    await this.inflight
  }

  /**
   * Drops the queued value without saving (content was replaced from
   * elsewhere, e.g. Claude rewrote the plano macro). An in-flight save still
   * completes.
   */
  cancel(): void {
    this.clearTimer()
    this.pending = null
    if (!this.inflight) this.setStatus('saved')
  }

  /** Stops the timer without saving (call `flush()` first if needed). */
  dispose(): void {
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private setStatus(status: SaveStatus, error?: unknown): void {
    this._status = status
    this.onStatus?.(status, error)
  }
}

// ---- global flush registry -------------------------------------------------
// Every live autosaver registers its flush here so the app can write
// everything at once: leaving the workspace, switching tabs, window hidden,
// app quitting (main sends `events:flushRequest`).

export interface FlushOptions {
  /** The app is quitting: whatever is still on screen will not survive. */
  leaving?: boolean
}

const flushers = new Set<(opts: FlushOptions) => Promise<void>>()

export function registerFlusher(fn: (opts: FlushOptions) => Promise<void>): () => void {
  flushers.add(fn)
  return () => {
    flushers.delete(fn)
  }
}

export async function flushAll(opts: FlushOptions = {}): Promise<void> {
  await Promise.allSettled([...flushers].map((fn) => fn(opts)))
}
