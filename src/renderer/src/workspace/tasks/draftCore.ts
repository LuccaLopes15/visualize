// State machine behind `useDraft` (pure: unit-tested in Node). A text field edited locally
// while the stored value (`base`) can change underneath it.
//
// - The server may normalise what we send (descriptions are trimmed): an echo of our own commit
//   must NEVER overwrite the text (it would eat the space the user just typed).
// - A genuinely different value arriving while the user has unsent edits is a conflict: it is
//   kept aside (`conflict`) and the commit is held until the user chooses.
// - Leaving the field (other node, panel closed, app quitting) with the conflict still open must
//   lose neither side: with a `Merge` rule both versions are written together (`leave`).

export type Normalize = (text: string) => string
const trimmed: Normalize = (s) => s.trim()

/** Combines the stored (Claude's) version and the user's unsent draft into one text. */
export type Merge = (remote: string, mine: string) => string

/** Claude's version first, then the user's draft under a marker (an empty side is skipped). */
export const mergeDrafts: Merge = (remote, mine) => {
  if (!mine.trim()) return remote
  if (!remote.trim()) return mine
  return `${remote}\n\n---\n\n**Seu rascunho** (escrito enquanto o Claude alterava esta descrição):\n\n${mine}`
}

export class DraftCore {
  /** What the field shows. */
  text: string
  /** The stored value this draft is based on (last value adopted from / confirmed by the server). */
  base: string
  /** Unsent local edits. */
  dirty = false
  /** Last text handed to `commit` and not yet confirmed by an incoming value. */
  sent: string | null = null
  /** A different stored value that arrived while `dirty` (null = none). */
  conflict: string | null = null

  constructor(
    value: string,
    private readonly normalize: Normalize = trimmed
  ) {
    this.text = value
    this.base = value
  }

  /** The user typed. */
  edit(next: string): void {
    this.text = next
    this.dirty = true
  }

  /** A stored value arrived (prop change). Returns true when something visible changed. */
  remote(server: string): boolean {
    if (server === this.base) return false
    const n = this.normalize
    const ours = server === n(this.text) || (this.sent !== null && (server === this.sent || server === n(this.sent)))
    if (ours) {
      // Echo of what we have / sent (possibly trimmed): adopt as the new base, keep the text as typed.
      this.base = server
      this.sent = null
      this.conflict = null
      return false
    }
    if (!this.dirty) {
      this.text = server
      this.base = server
      this.sent = null
      this.conflict = null
      return true
    }
    if (this.conflict === server) return false
    this.conflict = server
    return true
  }

  /**
   * The text to commit now, or null (nothing to write / held by a conflict). Marks the draft
   * clean and remembers what was sent so the server's (normalised) echo is recognised.
   */
  flush(): string | null {
    if (!this.dirty || this.conflict !== null) return null
    this.dirty = false
    if (this.text === this.base || this.normalize(this.text) === this.base) return null
    this.sent = this.text
    return this.text
  }

  /**
   * The field is going away. Same as `flush`, except that an open conflict is resolved with
   * `merge` (both versions kept) instead of holding the user's text, which would be lost.
   * Without `merge` the conflict stays held, as in `flush`.
   */
  leave(merge?: Merge): string | null {
    if (this.conflict !== null && this.dirty && merge) {
      this.text = merge(this.conflict, this.text)
      this.base = this.conflict
      this.conflict = null
    }
    return this.flush()
  }

  /** Drop the edit, go back to the stored value. */
  reset(): void {
    this.text = this.base
    this.dirty = false
    this.sent = null
    this.conflict = null
  }

  /** Conflict resolution: take the stored (remote) version and discard the local edit. */
  acceptRemote(): void {
    if (this.conflict === null) return
    this.text = this.conflict
    this.base = this.conflict
    this.dirty = false
    this.sent = null
    this.conflict = null
  }

  /** Conflict resolution: keep the local edit (the next `flush` overwrites the remote version). */
  keepMine(): void {
    if (this.conflict === null) return
    this.base = this.conflict
    this.conflict = null
  }
}
