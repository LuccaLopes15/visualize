// Fase 5: small Azure DevOps REST client (api-version 7.1). Runs only in the main
// process: the PAT never reaches the renderer. `fetch` and `sleep` are injectable
// so tests run without network or real waits.
//
// The PAT lives in a private field and is only used to build the Authorization
// header; nothing here logs it, and errors never include request headers.
import { DevOpsError, errorForStatus } from './errors'
import {
  buildCreatePatch,
  buildUpdatePatch,
  relationOp,
  type JsonPatchOp,
  type NewWorkItemInput,
  type RelationType,
  type WorkItemUpdateInput
} from './patch'

export const API_VERSION = '7.1'

/** Requirement types, in the order we prefer them (Agile, Scrum, CMMI). */
export const REQUIREMENT_TYPES = ['User Story', 'Product Backlog Item', 'Requirement'] as const

/**
 * Fields the app fills by itself (or the server manages), never asked as
 * "required" in the dialog.
 */
const APP_FILLED_FIELDS = new Set([
  'System.Title',
  'System.Description',
  'System.AreaPath',
  'System.IterationPath',
  'System.WorkItemType',
  'System.TeamProject',
  'System.State',
  'System.Reason',
  'System.Id',
  'System.Rev',
  'System.CreatedBy',
  'System.CreatedDate',
  'System.ChangedBy',
  'System.ChangedDate',
  'System.AuthorizedAs',
  'System.AuthorizedDate',
  'System.RevisedDate',
  'System.Watermark'
])

/**
 * Accepts `https://<org>.visualstudio.com` (legacy) or `https://dev.azure.com/<org>`,
 * with or without trailing slash / `DefaultCollection`. Returns the base URL without
 * trailing slash. Throws `DevOpsError('invalid_url')`. Pure.
 */
export function normalizeOrgUrl(raw: string): string {
  const invalid = (): DevOpsError =>
    new DevOpsError(
      'invalid_url',
      'URL da organização inválida. Use https://<sua-org>.visualstudio.com ou https://dev.azure.com/<sua-org>.'
    )
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw invalid()
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) throw invalid()
  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[segments.length - 1]?.toLowerCase() === 'defaultcollection') segments.pop()
  if (host === 'dev.azure.com') {
    if (segments.length !== 1) throw invalid()
    return `https://dev.azure.com/${segments[0]}`
  }
  const legacy = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/.exec(host)
  if (legacy && segments.length === 0) return `https://${legacy[1]}.visualstudio.com`
  throw invalid()
}

/** Picks the process' requirement type among the project's type names, or null. Pure. */
export function detectRequirementType(typeNames: readonly string[]): string | null {
  for (const t of REQUIREMENT_TYPES) {
    if (typeNames.includes(t)) return t
  }
  return null
}

interface ClassificationNode {
  name: string
  children?: ClassificationNode[]
}

/** Flattens a classification tree into paths `Projeto\Área\Sub` (pre-order). Pure. */
export function flattenClassificationPaths(root: ClassificationNode): string[] {
  const out: string[] = []
  const walk = (node: ClassificationNode, prefix: string): void => {
    const path = prefix ? `${prefix}\\${node.name}` : node.name
    out.push(path)
    for (const child of node.children ?? []) walk(child, path)
  }
  walk(root, '')
  return out
}

export interface DevOpsProject {
  id: string
  name: string
}

export interface WorkItemType {
  name: string
  referenceName: string
}

export interface RequiredField {
  referenceName: string
  name: string
  defaultValue: unknown
  allowedValues: unknown[]
}

export interface WorkItemRef {
  id: number
  /** API URL of the work item (used for relations). */
  url: string
  /** Browser URL (`_links.html.href`), when the API returns it. */
  htmlUrl: string | null
}

export interface DevOpsClientOptions {
  orgUrl: string
  pat: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Retries on 429/503 (default 3). */
  maxRetries?: number
  /** Cap for any single wait, Retry-After included (default 30 s). */
  maxDelayMs?: number
}

type Query = Record<string, string | number | undefined>

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class DevOpsClient {
  readonly orgUrl: string
  readonly #auth: string
  readonly #fetch: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #maxRetries: number
  readonly #maxDelayMs: number

  constructor(opts: DevOpsClientOptions) {
    this.orgUrl = normalizeOrgUrl(opts.orgUrl)
    // Basic auth with an empty user name.
    this.#auth = 'Basic ' + Buffer.from(`:${opts.pat}`, 'utf8').toString('base64')
    this.#fetch = opts.fetch ?? fetch
    this.#sleep = opts.sleep ?? defaultSleep
    this.#maxRetries = opts.maxRetries ?? 3
    this.#maxDelayMs = opts.maxDelayMs ?? 30_000
  }

  // ---- reads -----------------------------------------------------------------

  /** All projects of the org (follows `continuationToken`). */
  async listProjects(): Promise<DevOpsProject[]> {
    const out: DevOpsProject[] = []
    let token: string | undefined
    // Guard against a server that keeps returning the same token.
    for (let page = 0; page < 1000; page++) {
      const { body, headers } = await this.#request('GET', '_apis/projects', {
        query: { $top: 100, continuationToken: token }
      })
      const data = body as { value?: { id: string; name: string }[]; continuationToken?: string }
      for (const p of data.value ?? []) out.push({ id: p.id, name: p.name })
      const next = headers.get('x-ms-continuationtoken') ?? data.continuationToken ?? undefined
      if (!next || next === token) break
      token = next
    }
    return out
  }

  /** Area paths of a project, flattened (`Projeto\Área\Sub`). */
  listAreaPaths(project: string, depth = 10): Promise<string[]> {
    return this.#classificationPaths(project, 'Areas', depth)
  }

  /** Iteration paths of a project, flattened (`Projeto\Sprint 1`). */
  listIterationPaths(project: string, depth = 10): Promise<string[]> {
    return this.#classificationPaths(project, 'Iterations', depth)
  }

  /** Enabled work item types of a project. */
  async listWorkItemTypes(project: string): Promise<WorkItemType[]> {
    const { body } = await this.#request('GET', `${enc(project)}/_apis/wit/workitemtypes`)
    const data = body as { value?: { name: string; referenceName: string; isDisabled?: boolean }[] }
    return (data.value ?? [])
      .filter((t) => !t.isDisabled)
      .map((t) => ({ name: t.name, referenceName: t.referenceName }))
  }

  /** The process' requirement type (User Story / Product Backlog Item / Requirement) for a project, or null. */
  async requirementType(project: string): Promise<string | null> {
    const types = await this.listWorkItemTypes(project)
    return detectRequirementType(types.map((t) => t.name))
  }

  /** Always-required fields of a type the user must fill (fields the app sets are left out). */
  async requiredFields(project: string, type: string): Promise<RequiredField[]> {
    const { body } = await this.#request('GET', `${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/fields`, {
      query: { $expand: 'all' }
    })
    const data = body as {
      value?: { referenceName: string; name: string; alwaysRequired?: boolean; defaultValue?: unknown; allowedValues?: unknown[] }[]
    }
    return (data.value ?? [])
      .filter((f) => f.alwaysRequired && !APP_FILLED_FIELDS.has(f.referenceName))
      .map((f) => ({
        referenceName: f.referenceName,
        name: f.name,
        defaultValue: f.defaultValue ?? null,
        allowedValues: f.allowedValues ?? []
      }))
  }

  // ---- writes ----------------------------------------------------------------

  /** Creates a work item of `type` (e.g. `Task`, `User Story`) in `project`. */
  async createWorkItem(project: string, type: string, input: NewWorkItemInput): Promise<WorkItemRef> {
    const { body } = await this.#request('POST', `${enc(project)}/_apis/wit/workitems/$${enc(type)}`, {
      patch: buildCreatePatch(input)
    })
    return toRef(body)
  }

  /** Updates title and/or description of an existing work item. */
  async updateWorkItem(id: number, input: WorkItemUpdateInput): Promise<WorkItemRef> {
    const { body } = await this.#request('PATCH', `_apis/wit/workitems/${id}`, { patch: buildUpdatePatch(input) })
    return toRef(body)
  }

  /** Adds a parent/predecessor link from work item `id` to the item at `targetUrl`. */
  async addRelation(id: number, rel: RelationType, targetUrl: string): Promise<WorkItemRef> {
    const { body } = await this.#request('PATCH', `_apis/wit/workitems/${id}`, { patch: [relationOp(rel, targetUrl)] })
    return toRef(body)
  }

  // ---- internals -------------------------------------------------------------

  async #classificationPaths(project: string, group: 'Areas' | 'Iterations', depth: number): Promise<string[]> {
    const { body } = await this.#request('GET', `${enc(project)}/_apis/wit/classificationnodes/${group}`, {
      query: { $depth: depth }
    })
    return flattenClassificationPaths(body as ClassificationNode)
  }

  #url(path: string, query: Query = {}): string {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v))
    }
    params.set('api-version', API_VERSION)
    return `${this.orgUrl}/${path}?${params.toString()}`
  }

  async #request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    opts: { query?: Query; patch?: JsonPatchOp[] } = {}
  ): Promise<{ body: unknown; headers: Headers }> {
    const url = this.#url(path, opts.query)
    // Without X-TFS-FedAuthRedirect a bad PAT gets a 302 to the sign-in page instead of a 401.
    const headers: Record<string, string> = {
      Authorization: this.#auth,
      Accept: 'application/json',
      'X-TFS-FedAuthRedirect': 'Suppress'
    }
    let payload: string | undefined
    if (opts.patch) {
      headers['Content-Type'] = 'application/json-patch+json'
      payload = JSON.stringify(opts.patch)
    }

    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.#fetch(url, { method, headers, body: payload })
      } catch {
        throw new DevOpsError('network', 'Não foi possível conectar ao Azure DevOps. Confira a internet e a URL da organização.')
      }

      if ((res.status === 429 || res.status === 503) && attempt < this.#maxRetries) {
        await this.#sleep(this.#retryDelay(res.headers.get('retry-after'), attempt))
        continue
      }
      if (!res.ok) throw errorForStatus(res.status, await serverMessage(res))
      // 203 is the sign-in page Azure answers when it redirects a rejected PAT anyway.
      if (res.status === 203) throw errorForStatus(401, null)

      // Any other non-JSON body means the URL does not point at the REST API.
      const text = await res.text()
      try {
        return { body: text ? JSON.parse(text) : {}, headers: res.headers }
      } catch {
        throw new DevOpsError(
          'unexpected',
          'Resposta inesperada do Azure DevOps (não é JSON). Confira a URL da organização e o PAT.',
          res.status
        )
      }
    }
  }

  /** Retry-After (seconds or HTTP date) when present, else 1 s, 2 s, 4 s...; always capped. */
  #retryDelay(retryAfter: string | null, attempt: number): number {
    let ms = 1000 * 2 ** attempt
    if (retryAfter) {
      const secs = Number(retryAfter)
      if (Number.isFinite(secs) && secs >= 0) ms = secs * 1000
      else {
        const at = Date.parse(retryAfter)
        if (!Number.isNaN(at)) ms = Math.max(0, at - Date.now())
      }
    }
    return Math.min(ms, this.#maxDelayMs)
  }
}

const enc = (segment: string): string => encodeURIComponent(segment)

async function serverMessage(res: Response): Promise<string | null> {
  try {
    const data = JSON.parse(await res.text()) as { message?: unknown }
    return typeof data.message === 'string' ? data.message : null
  } catch {
    return null
  }
}

function toRef(body: unknown): WorkItemRef {
  const b = body as { id?: unknown; url?: unknown; _links?: { html?: { href?: unknown } } }
  if (typeof b.id !== 'number' || typeof b.url !== 'string') {
    throw new DevOpsError('unexpected', 'Resposta inesperada do Azure DevOps (work item sem id).')
  }
  const html = b._links?.html?.href
  return { id: b.id, url: b.url, htmlUrl: typeof html === 'string' ? html : null }
}
