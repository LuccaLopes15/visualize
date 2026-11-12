import { describe, expect, it, vi } from 'vitest'
import {
  API_VERSION,
  DevOpsClient,
  detectRequirementType,
  flattenClassificationPaths,
  normalizeOrgUrl
} from './client'
import { DevOpsError, extractFieldName } from './errors'
import { LINK_PARENT, LINK_PREDECESSOR, buildCreatePatch, buildUpdatePatch, markdownToHtml, relationOp } from './patch'

const PAT = 'segredo-pat-123'
const AUTH = 'Basic ' + Buffer.from(`:${PAT}`).toString('base64')

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** fetch mock that answers the queued replies in order and records every call. */
function mockFetch(...replies: Reply[]): {
  fetch: typeof fetch
  calls: { url: URL; init: RequestInit }[]
} {
  const calls: { url: URL; init: RequestInit }[] = []
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} })
    const r = replies.shift()
    if (!r) throw new Error('chamada inesperada')
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
    return new Response(text, { status: r.status ?? 200, headers: r.headers })
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

function client(
  replies: Reply[],
  orgUrl = 'https://minha-org.visualstudio.com'
): { c: DevOpsClient; calls: { url: URL; init: RequestInit }[]; sleeps: number[] } {
  const { fetch, calls } = mockFetch(...replies)
  const sleeps: number[] = []
  const c = new DevOpsClient({
    orgUrl,
    pat: PAT,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    }
  })
  return { c, calls, sleeps }
}

const header = (init: RequestInit, name: string): string | undefined =>
  (init.headers as Record<string, string>)[name]

const workItem = (id: number): Reply => ({
  body: {
    id,
    url: `https://minha-org.visualstudio.com/_apis/wit/workItems/${id}`,
    _links: { html: { href: `https://minha-org.visualstudio.com/P/_workitems/edit/${id}` } }
  }
})

describe('normalizeOrgUrl', () => {
  it('accepts both org URL formats', () => {
    expect(normalizeOrgUrl('https://minha-org.visualstudio.com')).toBe('https://minha-org.visualstudio.com')
    expect(normalizeOrgUrl(' https://Minha-Org.visualstudio.com/ ')).toBe('https://minha-org.visualstudio.com')
    expect(normalizeOrgUrl('https://minha-org.visualstudio.com/DefaultCollection')).toBe(
      'https://minha-org.visualstudio.com'
    )
    expect(normalizeOrgUrl('https://dev.azure.com/minha-org')).toBe('https://dev.azure.com/minha-org')
    expect(normalizeOrgUrl('https://dev.azure.com/minha-org/')).toBe('https://dev.azure.com/minha-org')
  })

  it('rejects anything else', () => {
    for (const bad of [
      '',
      'minha-org',
      'http://minha-org.visualstudio.com',
      'https://dev.azure.com',
      'https://dev.azure.com/org/projeto',
      'https://minha-org.visualstudio.com/projeto',
      'https://exemplo.com/org',
      'https://dev.azure.com/org?x=1'
    ]) {
      expect(() => normalizeOrgUrl(bad), bad).toThrow(DevOpsError)
    }
  })
})

describe('pure helpers', () => {
  it('detects the requirement type of the process', () => {
    expect(detectRequirementType(['Bug', 'Task', 'User Story', 'Epic'])).toBe('User Story')
    expect(detectRequirementType(['Task', 'Product Backlog Item'])).toBe('Product Backlog Item')
    expect(detectRequirementType(['Task', 'Requirement'])).toBe('Requirement')
    expect(detectRequirementType(['Task', 'Issue'])).toBeNull()
  })

  it('flattens classification nodes into paths', () => {
    expect(
      flattenClassificationPaths({
        name: 'Proj',
        children: [{ name: 'Web', children: [{ name: 'Login' }] }, { name: 'API' }]
      })
    ).toEqual(['Proj', 'Proj\\Web', 'Proj\\Web\\Login', 'Proj\\API'])
  })

  it('extracts the field name from 400 messages', () => {
    expect(
      extractFieldName('TF401320: Rule Error for field Severity. Error code: Required, HasValues, LimitedToValues.')
    ).toBe('Severity')
    expect(extractFieldName('TF51535: Cannot find field Custom.Cliente.')).toBe('Custom.Cliente')
    expect(extractFieldName("The field 'Custom.Time' contains a value that is not in the list of supported values")).toBe(
      'Custom.Time'
    )
    expect(extractFieldName('VS402323: Something else')).toBeNull()
  })
})

describe('JSON Patch builders', () => {
  it('builds the create patch with every part', () => {
    expect(
      buildCreatePatch({
        title: 'Login',
        description: '# Oi\n\n- a',
        areaPath: 'Proj\\Web',
        iterationPath: 'Proj\\Sprint 1',
        fields: { 'Custom.Cliente': 'ACME' },
        parentUrl: 'https://dev.azure.com/o/_apis/wit/workItems/7'
      })
    ).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Login' },
      { op: 'add', path: '/fields/System.Description', value: '<h1>Oi</h1>\n<ul>\n<li>a</li>\n</ul>' },
      { op: 'add', path: '/fields/System.AreaPath', value: 'Proj\\Web' },
      { op: 'add', path: '/fields/System.IterationPath', value: 'Proj\\Sprint 1' },
      { op: 'add', path: '/fields/Custom.Cliente', value: 'ACME' },
      {
        op: 'add',
        path: '/relations/-',
        value: { rel: LINK_PARENT, url: 'https://dev.azure.com/o/_apis/wit/workItems/7' }
      }
    ])
  })

  it('omits empty description, iteration and parent', () => {
    expect(buildCreatePatch({ title: 'T', description: '  ', areaPath: 'Proj' })).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'T' },
      { op: 'add', path: '/fields/System.AreaPath', value: 'Proj' }
    ])
  })

  it('builds the update patch only with what was given', () => {
    expect(buildUpdatePatch({ title: 'Novo' })).toEqual([{ op: 'add', path: '/fields/System.Title', value: 'Novo' }])
    expect(buildUpdatePatch({ description: '' })).toEqual([
      { op: 'add', path: '/fields/System.Description', value: '' }
    ])
    expect(buildUpdatePatch({})).toEqual([])
  })

  it('builds relation ops', () => {
    expect(relationOp(LINK_PREDECESSOR, 'u')).toEqual({
      op: 'add',
      path: '/relations/-',
      value: { rel: 'System.LinkTypes.Dependency-Reverse', url: 'u' }
    })
  })

  it('escapes raw HTML in the markdown', () => {
    expect(markdownToHtml('<script>x</script>')).not.toContain('<script>')
    expect(markdownToHtml('a <b>b</b>')).toContain('&lt;b&gt;')
  })
})

describe('DevOpsClient requests', () => {
  it('sends Basic auth with empty user and api-version 7.1', async () => {
    const { c, calls } = client([{ body: { value: [] } }])
    await c.listProjects()
    expect(calls[0].init.method).toBe('GET')
    expect(header(calls[0].init, 'Authorization')).toBe(AUTH)
    expect(calls[0].url.searchParams.get('api-version')).toBe(API_VERSION)
    expect(API_VERSION).toBe('7.1')
  })

  it('uses the dev.azure.com base too', async () => {
    const { c, calls } = client([{ body: { value: [] } }], 'https://dev.azure.com/minha-org/')
    await c.listProjects()
    expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://dev.azure.com/minha-org/_apis/projects')
  })

  it('lists projects following the continuation token', async () => {
    const { c, calls } = client([
      { body: { value: [{ id: '1', name: 'A' }] }, headers: { 'x-ms-continuationtoken': 'tok2' } },
      { body: { value: [{ id: '2', name: 'B' }] } }
    ])
    expect(await c.listProjects()).toEqual([
      { id: '1', name: 'A' },
      { id: '2', name: 'B' }
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0].url.searchParams.get('continuationToken')).toBeNull()
    expect(calls[1].url.searchParams.get('continuationToken')).toBe('tok2')
  })

  it('lists areas and iterations as paths', async () => {
    const { c, calls } = client([
      { body: { name: 'Meu Proj', children: [{ name: 'Web' }] } },
      { body: { name: 'Meu Proj', children: [{ name: 'Sprint 1' }] } }
    ])
    expect(await c.listAreaPaths('Meu Proj', 3)).toEqual(['Meu Proj', 'Meu Proj\\Web'])
    expect(await c.listIterationPaths('Meu Proj')).toEqual(['Meu Proj', 'Meu Proj\\Sprint 1'])
    expect(calls[0].url.pathname).toBe('/Meu%20Proj/_apis/wit/classificationnodes/Areas')
    expect(calls[0].url.searchParams.get('$depth')).toBe('3')
    expect(calls[1].url.pathname).toBe('/Meu%20Proj/_apis/wit/classificationnodes/Iterations')
  })

  it('lists work item types and detects the requirement type', async () => {
    const types = {
      value: [
        { name: 'Task', referenceName: 'Microsoft.VSTS.WorkItemTypes.Task' },
        { name: 'Product Backlog Item', referenceName: 'Microsoft.VSTS.WorkItemTypes.ProductBacklogItem' },
        { name: 'User Story', referenceName: 'x', isDisabled: true }
      ]
    }
    const { c, calls } = client([{ body: types }, { body: types }])
    expect(await c.listWorkItemTypes('P')).toEqual([
      { name: 'Task', referenceName: 'Microsoft.VSTS.WorkItemTypes.Task' },
      { name: 'Product Backlog Item', referenceName: 'Microsoft.VSTS.WorkItemTypes.ProductBacklogItem' }
    ])
    expect(await c.requirementType('P')).toBe('Product Backlog Item')
    expect(calls[0].url.pathname).toBe('/P/_apis/wit/workitemtypes')
  })

  it('returns only always-required fields the app does not fill', async () => {
    const { c, calls } = client([
      {
        body: {
          value: [
            { referenceName: 'System.Title', name: 'Title', alwaysRequired: true },
            { referenceName: 'System.State', name: 'State', alwaysRequired: true, defaultValue: 'New' },
            { referenceName: 'Custom.Cliente', name: 'Cliente', alwaysRequired: true, allowedValues: ['A', 'B'] },
            { referenceName: 'System.Tags', name: 'Tags', alwaysRequired: false }
          ]
        }
      }
    ])
    expect(await c.requiredFields('P', 'User Story')).toEqual([
      { referenceName: 'Custom.Cliente', name: 'Cliente', defaultValue: null, allowedValues: ['A', 'B'] }
    ])
    expect(calls[0].url.pathname).toBe('/P/_apis/wit/workitemtypes/User%20Story/fields')
    expect(calls[0].url.searchParams.get('$expand')).toBe('all')
  })

  it('creates a work item with a JSON Patch', async () => {
    const { c, calls } = client([workItem(42)])
    const ref = await c.createWorkItem('P', 'User Story', {
      title: 'T',
      areaPath: 'P',
      parentUrl: 'https://minha-org.visualstudio.com/_apis/wit/workItems/7'
    })
    expect(ref).toEqual({
      id: 42,
      url: 'https://minha-org.visualstudio.com/_apis/wit/workItems/42',
      htmlUrl: 'https://minha-org.visualstudio.com/P/_workitems/edit/42'
    })
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].url.pathname).toBe('/P/_apis/wit/workitems/$User%20Story')
    expect(header(calls[0].init, 'Content-Type')).toBe('application/json-patch+json')
    expect(JSON.parse(calls[0].init.body as string)).toEqual(
      buildCreatePatch({ title: 'T', areaPath: 'P', parentUrl: 'https://minha-org.visualstudio.com/_apis/wit/workItems/7' })
    )
  })

  it('patches title/description and adds relations', async () => {
    const { c, calls } = client([workItem(5), workItem(5)])
    await c.updateWorkItem(5, { title: 'Novo', description: 'texto' })
    await c.addRelation(5, LINK_PREDECESSOR, 'https://minha-org.visualstudio.com/_apis/wit/workItems/9')
    for (const call of calls) {
      expect(call.init.method).toBe('PATCH')
      expect(call.url.pathname).toBe('/_apis/wit/workitems/5')
      expect(header(call.init, 'Content-Type')).toBe('application/json-patch+json')
    }
    expect(JSON.parse(calls[0].init.body as string)).toEqual(buildUpdatePatch({ title: 'Novo', description: 'texto' }))
    expect(JSON.parse(calls[1].init.body as string)).toEqual([
      relationOp(LINK_PREDECESSOR, 'https://minha-org.visualstudio.com/_apis/wit/workItems/9')
    ])
  })

  it('does not expose the PAT on the client object', () => {
    const { c } = client([])
    expect(JSON.stringify(c)).not.toContain(PAT)
    expect(JSON.stringify(c)).not.toContain(AUTH)
    expect(Object.values(c).join(' ')).not.toContain(AUTH)
  })
})

describe('DevOpsClient errors', () => {
  const failWith = async (reply: Reply): Promise<DevOpsError> => {
    const { c } = client([reply, reply, reply, reply])
    const err = await c.listProjects().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DevOpsError)
    return err as DevOpsError
  }

  it('maps each status to a distinguishable kind with pt-BR message', async () => {
    expect((await failWith({ status: 401 })).kind).toBe('auth')
    expect((await failWith({ status: 403, body: { message: 'sem escopo' } })).kind).toBe('forbidden')
    expect((await failWith({ status: 404 })).kind).toBe('not_found')
    expect((await failWith({ status: 400, body: { message: 'VS1: outra coisa' } })).kind).toBe('bad_request')
    expect((await failWith({ status: 500 })).kind).toBe('unexpected')
    const auth = await failWith({ status: 401 })
    expect(auth.status).toBe(401)
    expect(auth.message).toMatch(/PAT/)
  })

  it('extracts the field from a 400', async () => {
    const err = await failWith({
      status: 400,
      body: { message: 'TF401320: Rule Error for field Cliente. Error code: Required, InvalidEmpty.' }
    })
    expect(err.kind).toBe('field')
    expect(err.field).toBe('Cliente')
    expect(err.message).toContain('Cliente')
  })

  it('never puts the PAT or the Authorization header in error messages', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const err = await failWith({ status, body: { message: 'x' } })
      expect(err.message).not.toContain(PAT)
      expect(err.message).not.toContain(AUTH)
    }
  })

  it('wraps network failures', async () => {
    const c = new DevOpsClient({
      orgUrl: 'https://dev.azure.com/o',
      pat: PAT,
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch
    })
    await expect(c.listProjects()).rejects.toMatchObject({ kind: 'network' })
  })

  it('rejects non-JSON bodies (sign-in page)', async () => {
    const err = await failWith({ status: 203, body: '<html>login</html>' })
    expect(err.kind).toBe('unexpected')
  })

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const { c, calls, sleeps } = client([
      { status: 429, headers: { 'Retry-After': '2' } },
      { status: 503 },
      { body: { value: [{ id: '1', name: 'A' }] } }
    ])
    expect(await c.listProjects()).toEqual([{ id: '1', name: 'A' }])
    expect(calls).toHaveLength(3)
    expect(sleeps).toEqual([2000, 2000]) // Retry-After 2 s; then backoff 1 s * 2^1
  })

  it('caps the wait and gives up after the retries', async () => {
    const { c, calls, sleeps } = client([
      { status: 429, headers: { 'Retry-After': '3600' } },
      { status: 429 },
      { status: 429 },
      { status: 429 }
    ])
    await expect(c.listProjects()).rejects.toMatchObject({ kind: 'rate_limited', status: 429 })
    expect(calls).toHaveLength(4) // 1 + 3 retries
    expect(sleeps).toEqual([30_000, 2000, 4000])
  })

  it('gives up on 503 as unavailable', async () => {
    const err = await failWith({ status: 503 })
    expect(err.kind).toBe('unavailable')
  })
})
