// Fase 5: pure builders for the JSON Patch documents Azure DevOps takes
// (`application/json-patch+json`) and the markdown -> HTML used for descriptions.
import { Marked } from 'marked'

export interface JsonPatchOp {
  op: 'add' | 'replace' | 'remove' | 'test'
  path: string
  value?: unknown
}

/** Link types the app creates. Reverse = "this item points at its parent / predecessor". */
export const LINK_PARENT = 'System.LinkTypes.Hierarchy-Reverse'
export const LINK_PREDECESSOR = 'System.LinkTypes.Dependency-Reverse'
export type RelationType = typeof LINK_PARENT | typeof LINK_PREDECESSOR

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Raw HTML in the markdown is shown as text, never sent as markup.
const md = new Marked({ gfm: true, breaks: false, async: false })
md.use({ renderer: { html: ({ text }) => escapeHtml(text) } })

/** Markdown -> HTML for `System.Description`. Empty/blank -> ''. */
export function markdownToHtml(source: string): string {
  if (!source.trim()) return ''
  return (md.parse(source) as string).trim()
}

const field = (ref: string): string => `/fields/${ref}`

export interface NewWorkItemInput {
  title: string
  /** Markdown; converted to HTML. */
  description?: string
  areaPath: string
  iterationPath?: string | null
  /** Extra fields (required custom fields), by reference name. */
  fields?: Record<string, unknown>
  /** URL of the parent work item (`.../_apis/wit/workItems/{id}`). */
  parentUrl?: string | null
}

/** Relation op that appends a link to another work item (by its URL; works cross-project in the org). */
export function relationOp(rel: RelationType, targetUrl: string): JsonPatchOp {
  return { op: 'add', path: '/relations/-', value: { rel, url: targetUrl } }
}

/** Patch for `POST {project}/_apis/wit/workitems/${type}`. */
export function buildCreatePatch(input: NewWorkItemInput): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [{ op: 'add', path: field('System.Title'), value: input.title }]
  const html = markdownToHtml(input.description ?? '')
  if (html) ops.push({ op: 'add', path: field('System.Description'), value: html })
  ops.push({ op: 'add', path: field('System.AreaPath'), value: input.areaPath })
  if (input.iterationPath) ops.push({ op: 'add', path: field('System.IterationPath'), value: input.iterationPath })
  for (const [ref, value] of Object.entries(input.fields ?? {})) {
    ops.push({ op: 'add', path: field(ref), value })
  }
  if (input.parentUrl) ops.push(relationOp(LINK_PARENT, input.parentUrl))
  return ops
}

export interface WorkItemUpdateInput {
  title?: string
  /** Markdown; converted to HTML (empty clears the description). */
  description?: string
}

/** Patch for `PATCH _apis/wit/workitems/{id}` (title / description only). */
export function buildUpdatePatch(input: WorkItemUpdateInput): JsonPatchOp[] {
  const ops: JsonPatchOp[] = []
  if (input.title !== undefined) ops.push({ op: 'add', path: field('System.Title'), value: input.title })
  if (input.description !== undefined) {
    ops.push({ op: 'add', path: field('System.Description'), value: markdownToHtml(input.description) })
  }
  return ops
}
