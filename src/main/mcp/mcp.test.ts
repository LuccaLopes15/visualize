import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { BoardOp } from '@shared/board'
import { createRepositories } from '../db'
import { PlanService } from '../plan/service'
import { VisualizeMcpServer } from './server'
import { appendSection } from './tools'
import { VISUALIZE_TOOL_NAMES } from './toolNames'

let server: VisualizeMcpServer
const plans = new Map<number, string>()
const boardCalls: { ideaId: number; op: BoardOp }[] = []

beforeEach(async () => {
  plans.clear()
  plans.set(1, '# Plano da ideia 1')
  plans.set(2, '# Plano SECRETO da ideia 2')
  boardCalls.length = 0
  server = new VisualizeMcpServer({
    board: async (ideaId, op) => {
      boardCalls.push({ ideaId, op })
      return { ok: true, text: `board da ideia ${ideaId}` }
    },
    macro: {
      read: async (ideaId) => ({ markdown: plans.get(ideaId) ?? '', updatedAt: 1 }),
      write: async (ideaId, markdown) => {
        plans.set(ideaId, markdown)
        return { updatedAt: 2 }
      }
    },
    plan: new PlanService(createRepositories(':memory:').plan)
  })
  await server.start()
})

afterEach(async () => {
  await server.close()
})

async function post(headers: Record<string, string>): Promise<number> {
  const res = await fetch(server.url(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })
  return res.status
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url()), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return client
}

const textOf = (r: unknown): string =>
  ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n')

describe('VisualizeMcpServer auth', () => {
  it('binds to 127.0.0.1 and rejects requests without a valid token', async () => {
    expect(server.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(await post({})).toBe(401)
    expect(await post({ Authorization: 'Bearer nope' })).toBe(401)
    const token = server.issueToken(1)
    expect(await post({ Authorization: `Bearer ${token}` })).toBe(200)
    server.revokeToken(token)
    expect(await post({ Authorization: `Bearer ${token}` })).toBe(401)
  })

  it('lists the visualize tools', async () => {
    const client = await connect(server.issueToken(1))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'board_add',
      'board_add_flow',
      'board_delete',
      'board_read',
      'board_update',
      'macro_append_section',
      'macro_read',
      'macro_write',
      'tasks_add',
      'tasks_add_dep',
      'tasks_delete_node',
      'tasks_read',
      'tasks_remove_dep',
      'tasks_reorder',
      'tasks_replace_all',
      'tasks_set_parent',
      'tasks_update_node'
    ])
    // The CLI's --allowedTools is built from this list: it must match what the server exposes.
    expect([...VISUALIZE_TOOL_NAMES].sort()).toEqual(tools.map((t) => t.name).sort())
    await client.close()
  })

  it('scopes every tool to the idea of the token', async () => {
    const c1 = await connect(server.issueToken(1))
    const c2 = await connect(server.issueToken(2))
    expect(textOf(await c1.callTool({ name: 'macro_read', arguments: {} }))).toBe('# Plano da ideia 1')
    expect(textOf(await c2.callTool({ name: 'macro_read', arguments: {} }))).toContain('SECRETO')

    // Extra arguments can't redirect a call to another idea.
    await c1.callTool({ name: 'macro_write', arguments: { markdown: 'novo', ideaId: 2 } })
    expect(plans.get(1)).toBe('novo')
    expect(plans.get(2)).toContain('SECRETO')

    await c1.callTool({
      name: 'board_add_flow',
      arguments: { title: 'F', nodes: [{ id: 'a', label: 'A' }], edges: [] }
    })
    expect(boardCalls).toEqual([
      { ideaId: 1, op: { op: 'addFlow', flow: { title: 'F', direction: undefined, frame: undefined, nodes: [{ id: 'a', label: 'A' }], edges: [] } } }
    ])
    await c1.close()
    await c2.close()
  })

  it('validates input with zod and appends sections', async () => {
    const client = await connect(server.issueToken(1))
    const bad = await client.callTool({ name: 'board_add', arguments: { elements: [] } })
    expect(bad.isError).toBe(true)
    await client.callTool({ name: 'macro_append_section', arguments: { heading: 'Riscos', body: '- prazo' } })
    expect(plans.get(1)).toBe('# Plano da ideia 1\n\n## Riscos\n\n- prazo\n')
    await client.close()
  })
})

describe('appendSection', () => {
  it('keeps explicit heading levels and handles empty plans', () => {
    expect(appendSection('', '### Nota', 'x')).toBe('### Nota\n\nx\n')
    expect(appendSection('a\n\n\n', 'B', ' y ')).toBe('a\n\n## B\n\ny\n')
  })
})
