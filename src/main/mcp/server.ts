// Local MCP server ("visualize") over Streamable HTTP, bound to 127.0.0.1 on a
// random port. Each chat session gets its own random Bearer token mapped to
// its idea; requests without a known token get 401. Stateless: a fresh
// McpServer + transport per request, built for the token's idea, so tools can
// only ever see that idea.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { registerVisualizeTools, type McpToolDeps } from './tools'

const MAX_BODY = 4 * 1024 * 1024

export class VisualizeMcpServer {
  private server: Server | null = null
  private port = 0
  private readonly tokens = new Map<string, number>()

  constructor(
    private readonly deps: McpToolDeps,
    private readonly version = '0.1.0'
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
    console.log(`[mcp] visualize em http://127.0.0.1:${this.port}/mcp`)
  }

  url(): string {
    if (!this.server) throw new Error('Servidor MCP não iniciado.')
    return `http://127.0.0.1:${this.port}/mcp`
  }

  issueToken(ideaId: number): string {
    const token = randomBytes(32).toString('base64url')
    this.tokens.set(token, ideaId)
    return token
  }

  revokeToken(token: string): void {
    this.tokens.delete(token)
  }

  async close(): Promise<void> {
    const s = this.server
    this.server = null
    this.tokens.clear()
    if (s) {
      s.closeAllConnections?.()
      await new Promise<void>((r) => s.close(() => r()))
    }
  }

  /** idea bound to the request's Bearer token, or null. */
  private ideaFor(req: IncomingMessage): number | null {
    const header = req.headers['authorization']
    const m = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null
    if (!m) return null
    const given = Buffer.from(m[1])
    for (const [token, ideaId] of this.tokens) {
      const t = Buffer.from(token)
      if (t.length === given.length && timingSafeEqual(t, given)) return ideaId
    }
    return null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = (req.url ?? '').split('?')[0]
      if (path !== '/mcp') {
        res.writeHead(404).end()
        return
      }
      const ideaId = this.ideaFor(req)
      if (ideaId === null) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }))
        return
      }
      if (req.method !== 'POST') {
        // Stateless server: no SSE stream / session to GET or DELETE.
        res.writeHead(405, { allow: 'POST' }).end()
        return
      }
      const body = await readJson(req)
      const mcp = new McpServer({ name: 'visualize', version: this.version })
      registerVisualizeTools(mcp, ideaId, this.deps)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      console.error('[mcp] erro na requisição', err)
      if (!res.headersSent) {
        res.writeHead(err instanceof BadRequest ? 400 : 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: null }))
      }
    }
  }
}

class BadRequest extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new BadRequest('corpo grande demais')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new BadRequest('JSON inválido')
  }
}
