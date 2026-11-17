// Safety net for the chat: Claude sometimes writes internal ids (task node
// prefixes like "a4bcd585", board element ids) in its answers even though the
// system prompt forbids it. Before rendering, ids KNOWN to belong to this idea
// are swapped for the node/element title, or dropped when they only repeat a
// title already written next to them ("Criar login (a4bcd585)"). Unknown
// tokens (commit hashes, versions...) are never touched.
import type { ElementLike } from '../board/geometry'

/** An id the model may leak and what the user knows it by (empty: no text). */
export interface KnownId {
  id: string
  title: string
}

/** Shortest prefix of a task node UUID accepted as a leak (tools show >= 8 chars). */
const MIN_PREFIX = 8

/** A whole word-like token, optionally in backticks (`a4bcd585`). */
const TOKEN = /`([A-Za-z0-9_-]{6,})`|(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{6,})(?![A-Za-z0-9_-])/g
/** "(id)", "[id]", "(`id`, id)": a group made only of ids, with the space before it. */
const GROUP = /[ \t]?[([]([^()[\]\n]{6,300})[)\]]/g
const UNTITLED = 'elemento sem texto'

type Lookup = (token: string) => string | undefined

function lookup(known: KnownId[]): Lookup {
  const byId = new Map<string, string>()
  const uuids: KnownId[] = []
  for (const k of known) {
    byId.set(k.id, k.title)
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(k.id)) uuids.push(k)
  }
  return (token) => {
    const exact = byId.get(token)
    if (exact !== undefined) return exact
    if (token.length < MIN_PREFIX || !/^[0-9a-f-]+$/.test(token)) return undefined
    const hits = uuids.filter((k) => k.id.startsWith(token))
    return hits.length === 1 ? hits[0].title : undefined
  }
}

function label(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim()
  return t ? `"${t}"` : UNTITLED
}

/** Assistant text with the idea's known ids replaced by titles (or removed when in parentheses). */
export function hideKnownIds(text: string, known: KnownId[]): string {
  if (!known.length || !text) return text
  const find = lookup(known)

  // 1. Groups that hold nothing but ids: "Criar login (a4bcd585)" -> "Criar login".
  let out = text.replace(GROUP, (whole, inner: string) => {
    const parts = inner.split(/\s*(?:,|;|\be\b)\s*/).map((p) => p.trim().replace(/^`(.*)`$/, '$1'))
    const allIds = parts.length > 0 && parts.every((p) => p !== '' && find(p) !== undefined)
    return allIds ? '' : whole
  })

  // 2. Any id left in the text: "depende de a4bcd585" -> 'depende de "Criar login"'.
  out = out.replace(TOKEN, (whole, quoted: string | undefined, bare: string | undefined, offset: number, all: string) => {
    // Part of a path or ref (e.g. "src/a4bcd585", "#a4bcd585"): leave it.
    const before = all[offset - 1]
    if (bare && (before === '/' || before === '.' || before === '#')) return whole
    const title = find(quoted ?? bare ?? '')
    return title === undefined ? whole : label(title)
  })
  return out
}

/** Plan nodes as known ids (full UUID; prefixes are matched by `hideKnownIds`). */
export function planIds(nodes: { id: string; title: string }[]): KnownId[] {
  return nodes.map((n) => ({ id: n.id, title: n.title }))
}

/** Live board elements as known ids, titled by their own text, bound label or frame name. */
export function boardIds(elements: readonly ElementLike[]): KnownId[] {
  const live = elements.filter((e) => !e.isDeleted)
  const labels = new Map<string, string>() // container id -> bound text
  for (const e of live) {
    if (e.type === 'text' && e.containerId) labels.set(e.containerId, e.originalText ?? e.text ?? '')
  }
  return live.map((e) => ({
    id: e.id,
    title: labels.get(e.id) ?? (e.type === 'text' ? (e.originalText ?? e.text) : e.name) ?? ''
  }))
}
