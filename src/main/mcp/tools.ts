// Visualize tools exposed to Claude (server "visualize" → mcp__visualize__*).
// Every tool works on the idea bound to the caller's Bearer token: there is no
// idea id parameter, so a chat session can never touch another idea.
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ADD_KINDS, BOARD_COLORS, SHAPE_KINDS, type BoardOp, type BoardOpResult } from '@shared/board'

export interface McpToolDeps {
  /** Applies a board op on the live board of the idea (renderer). */
  board: (ideaId: number, op: BoardOp) => Promise<BoardOpResult>
  macro: {
    read: (ideaId: number) => Promise<{ markdown: string; updatedAt: number }>
    write: (ideaId: number, markdown: string) => Promise<{ updatedAt: number }>
  }
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {})
})

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    return text(`Erro: ${err instanceof Error ? err.message : String(err)}`, true)
  }
}

const boardResult = (r: BoardOpResult): ToolResult => text(r.text, !r.ok)

const colorSchema = z
  .enum(BOARD_COLORS)
  .describe('Cor do preenchimento/contorno (paleta do board; legível no tema escuro).')

const COLORS_HINT = `Cores: ${BOARD_COLORS.join(', ')}.`

export function registerVisualizeTools(server: McpServer, ideaId: number, deps: McpToolDeps): void {
  // ---- board ---------------------------------------------------------------
  server.registerTool(
    'board_read',
    {
      title: 'Ler o board',
      description:
        'Lê o board (Excalidraw) da ideia: lista os elementos com id, tipo, texto, posição/tamanho (x, y, w, h), cor e as conexões das setas, além da área total ocupada. Desenhos à mão livre aparecem resumidos como "traço livre na região"; imagens como "imagem". Use antes de alterar, apagar ou ligar setas a elementos existentes.',
      inputSchema: {
        maxElements: z
          .number()
          .int()
          .min(10)
          .max(500)
          .optional()
          .describe('Máximo de elementos listados (padrão 200).')
      },
      annotations: { readOnlyHint: true }
    },
    ({ maxElements }) => guard(async () => boardResult(await deps.board(ideaId, { op: 'read', maxElements })))
  )

  server.registerTool(
    'board_add',
    {
      title: 'Adicionar elementos ao board',
      description: `Adiciona elementos soltos ao board: caixas (rectangle/ellipse/diamond com label), note (bloco de anotação amarelo, estilo post-it), text (texto livre), arrow (seta ligando dois elementos, com label opcional) e frame (moldura nomeada em volta de elementos). Coordenadas são opcionais: sem x/y, os elementos são posicionados em espaço livre à direita do conteúdo existente. Setas e frames referenciam elementos por id existente (veja board_read) ou pelo "ref" de um elemento criado nesta mesma chamada. Retorna os ids gerados (estáveis, use-os em board_update/board_delete). Para fluxos/diagramas com várias etapas prefira board_add_flow, que faz o layout automático. ${COLORS_HINT}`,
      inputSchema: {
        elements: z
          .array(
            z.object({
              kind: z.enum(ADD_KINDS).describe('Tipo do elemento.'),
              ref: z.string().max(60).optional().describe('Apelido local para setas/frames desta chamada apontarem para este elemento.'),
              label: z
                .string()
                .max(2000)
                .optional()
                .describe('Texto: rótulo da caixa, conteúdo do note/text, rótulo da seta ou nome do frame. Obrigatório para text e note.'),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().positive().max(5000).optional(),
              height: z.number().positive().max(5000).optional(),
              color: colorSchema.optional(),
              fontSize: z.number().min(8).max(96).optional().describe('Só para text (padrão 20).'),
              from: z.string().optional().describe('Seta: id ou ref do elemento de origem.'),
              to: z.string().optional().describe('Seta: id ou ref do elemento de destino.'),
              style: z.enum(['solid', 'dashed']).optional().describe('Seta: traço (padrão solid).'),
              children: z.array(z.string()).optional().describe('Frame: ids/refs dos elementos que ele envolve.')
            })
          )
          .min(1)
          .max(100)
      }
    },
    ({ elements }) => guard(async () => boardResult(await deps.board(ideaId, { op: 'add', elements })))
  )

  server.registerTool(
    'board_add_flow',
    {
      title: 'Desenhar fluxo no board',
      description: `Desenha um fluxo/diagrama completo com layout automático (dagre): caixas do mesmo tamanho, espaçamento uniforme e setas ligadas às caixas. Use para "desenha o fluxo de…", etapas de um processo, arquitetura, jornada etc. Os ids de nodes são locais a esta chamada (ex.: "captura", "hub"); a resposta traz os ids reais criados no board. O fluxo vai para um espaço livre à direita do conteúdo existente e, com título, fica dentro de um frame nomeado. Formas: rectangle (padrão, etapa), diamond (decisão), ellipse (início/fim), note (observação). ${COLORS_HINT} Use cores com moderação (ex.: uma cor por tipo de etapa).`,
      inputSchema: {
        title: z.string().max(200).optional().describe('Título do fluxo (nome do frame).'),
        direction: z.enum(['LR', 'TB']).optional().describe('LR = esquerda→direita (padrão), TB = cima→baixo.'),
        frame: z.boolean().optional().describe('Envolver num frame (padrão: sim quando há título).'),
        nodes: z
          .array(
            z.object({
              id: z.string().min(1).max(60),
              label: z.string().min(1).max(300),
              shape: z.enum(SHAPE_KINDS).optional(),
              color: colorSchema.optional()
            })
          )
          .min(1)
          .max(60),
        edges: z
          .array(
            z.object({
              from: z.string().describe('id de um node desta chamada'),
              to: z.string().describe('id de um node desta chamada'),
              label: z.string().max(120).optional(),
              style: z.enum(['solid', 'dashed']).optional()
            })
          )
          .max(150)
          .optional()
      }
    },
    ({ title, direction, frame, nodes, edges }) =>
      guard(async () =>
        boardResult(
          await deps.board(ideaId, { op: 'addFlow', flow: { title, direction, frame, nodes, edges: edges ?? [] } })
        )
      )
  )

  server.registerTool(
    'board_update',
    {
      title: 'Alterar elementos do board',
      description: `Altera elementos existentes pelo id (veja board_read): texto/rótulo, posição (x, y), tamanho (width, height) e cor. Setas ligadas acompanham caixas movidas. ${COLORS_HINT}`,
      inputSchema: {
        updates: z
          .array(
            z.object({
              id: z.string(),
              label: z.string().max(2000).optional().describe('Novo texto (rótulo da caixa/seta, conteúdo do text/note, nome do frame).'),
              x: z.number().optional(),
              y: z.number().optional(),
              width: z.number().positive().max(5000).optional(),
              height: z.number().positive().max(5000).optional(),
              color: colorSchema.optional()
            })
          )
          .min(1)
          .max(100)
      }
    },
    ({ updates }) => guard(async () => boardResult(await deps.board(ideaId, { op: 'update', updates })))
  )

  server.registerTool(
    'board_delete',
    {
      title: 'Apagar elementos do board',
      description:
        'Apaga elementos pelo id (veja board_read). O texto de uma caixa vai junto; setas ligadas a ela ficam soltas. O usuário pode desfazer com Ctrl+Z.',
      inputSchema: { ids: z.array(z.string()).min(1).max(200) },
      annotations: { destructiveHint: true }
    },
    ({ ids }) => guard(async () => boardResult(await deps.board(ideaId, { op: 'delete', ids })))
  )

  // ---- plano macro ------------------------------------------------------------
  server.registerTool(
    'macro_read',
    {
      title: 'Ler o plano macro',
      description: 'Lê o plano macro (documento Markdown) da ideia, incluindo edições ainda não salvas do usuário.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    () =>
      guard(async () => {
        const plan = await deps.macro.read(ideaId)
        return text(plan.markdown.trim() ? plan.markdown : '(o plano macro está vazio)')
      })
  )

  server.registerTool(
    'macro_write',
    {
      title: 'Escrever o plano macro',
      description:
        'Substitui o plano macro inteiro pelo Markdown informado (sugestão de estrutura: # Objetivo, ## Escopo, ## Abordagem, ## Riscos e dúvidas, ## Próximos passos). Leia antes com macro_read para não perder o que o usuário escreveu. O usuário vê a atualização na hora e pode desfazer editando.',
      inputSchema: { markdown: z.string().max(200_000).describe('Documento completo em Markdown.') }
    },
    ({ markdown }) =>
      guard(async () => {
        await deps.macro.write(ideaId, markdown)
        return text(`Plano macro atualizado (${markdown.length} caracteres).`)
      })
  )

  server.registerTool(
    'macro_append_section',
    {
      title: 'Acrescentar seção ao plano macro',
      description: 'Acrescenta uma seção (título + corpo em Markdown) ao final do plano macro, sem mexer no resto.',
      inputSchema: {
        heading: z.string().min(1).max(200).describe('Título da seção (sem "#" vira "## Título").'),
        body: z.string().max(100_000).describe('Conteúdo da seção em Markdown.')
      }
    },
    ({ heading, body }) =>
      guard(async () => {
        const plan = await deps.macro.read(ideaId)
        const markdown = appendSection(plan.markdown, heading, body)
        await deps.macro.write(ideaId, markdown)
        return text(`Seção "${heading.replace(/^#+\s*/, '')}" acrescentada ao plano macro.`)
      })
  )
}

export function appendSection(markdown: string, heading: string, body: string): string {
  const h = heading.trim()
  const title = /^#{1,6}\s/.test(h) ? h : `## ${h.replace(/^#+/, '').trim()}`
  const base = markdown.replace(/\s+$/, '')
  return `${base ? base + '\n\n' : ''}${title}\n\n${body.trim()}\n`
}
