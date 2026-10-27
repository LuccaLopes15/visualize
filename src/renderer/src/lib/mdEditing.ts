// Small, pure text-editing helpers for the markdown textarea (plano macro).

export interface Edit {
  /** Replace [from, to) with `text`, then put the caret/selection at [selStart, selEnd]. */
  from: number
  to: number
  text: string
  selStart: number
  selEnd: number
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/

/**
 * Enter inside a list item continues the list ("- ", "1. " -> "2. ",
 * "- [x] " -> "- [ ] "). Enter on an empty item ends the list instead.
 * Returns null when Enter should behave normally.
 */
export function continueList(value: string, selStart: number, selEnd: number): Edit | null {
  if (selStart !== selEnd) return null
  const lineStart = value.lastIndexOf('\n', selStart - 1) + 1
  const line = value.slice(lineStart, selStart)
  const m = LIST_RE.exec(line)
  if (!m) return null
  const [whole, indent, marker, space, task] = m
  if (line.trim() === whole.trim()) {
    // Empty item: remove the marker, leaving a blank line.
    return { from: lineStart, to: selStart, text: '', selStart: lineStart, selEnd: lineStart }
  }
  let nextMarker = marker
  const num = /^(\d+)([.)])$/.exec(marker)
  if (num) nextMarker = `${Number(num[1]) + 1}${num[2]}`
  const insert = `\n${indent}${nextMarker}${space}${task ? '[ ] ' : ''}`
  return { from: selStart, to: selEnd, text: insert, selStart: selStart + insert.length, selEnd: selStart + insert.length }
}

/** Tab / Shift+Tab: indent or outdent every line touched by the selection (2 spaces). */
export function indentLines(value: string, selStart: number, selEnd: number, outdent: boolean): Edit {
  const from = value.lastIndexOf('\n', selStart - 1) + 1
  let to = value.indexOf('\n', selEnd > selStart && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd)
  if (to === -1) to = value.length
  const lines = value.slice(from, to).split('\n')
  let firstDelta = 0
  let total = 0
  const out = lines.map((l, i) => {
    let delta: number
    let next: string
    if (outdent) {
      const remove = l.startsWith('  ') ? 2 : l.startsWith(' ') || l.startsWith('\t') ? 1 : 0
      next = l.slice(remove)
      delta = -remove
    } else {
      next = `  ${l}`
      delta = 2
    }
    if (i === 0) firstDelta = delta
    total += delta
    return next
  })
  const text = out.join('\n')
  const single = selStart === selEnd
  return {
    from,
    to,
    text,
    selStart: Math.max(from, selStart + firstDelta),
    selEnd: single ? Math.max(from, selStart + firstDelta) : selEnd + total
  }
}
