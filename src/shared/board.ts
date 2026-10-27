// Fase 3: operations Claude's board tools ask the renderer to apply on the
// live Excalidraw scene. Main validates the input (zod, in src/main/mcp) and
// relays it over IPC; the renderer (src/renderer/src/workspace/board/*) builds
// the elements and replies with a text result written for the model.

export const BOARD_COLORS = [
  'gray',
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'purple',
  'pink',
  'teal'
] as const
export type BoardColor = (typeof BOARD_COLORS)[number]

export const SHAPE_KINDS = ['rectangle', 'ellipse', 'diamond', 'note'] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]

export const ADD_KINDS = ['rectangle', 'ellipse', 'diamond', 'note', 'text', 'arrow', 'frame'] as const
export type AddKind = (typeof ADD_KINDS)[number]

export type LineStyle = 'solid' | 'dashed'

export interface BoardAddElement {
  kind: AddKind
  /** Local alias so arrows/frames in the same call can point at this element. */
  ref?: string
  /** Shape label, note/text content, arrow label or frame name. */
  label?: string
  x?: number
  y?: number
  width?: number
  height?: number
  color?: BoardColor
  fontSize?: number
  /** Arrow: source/target (existing element id or a `ref` from this call). */
  from?: string
  to?: string
  style?: LineStyle
  /** Frame: ids/refs of the elements it encloses. */
  children?: string[]
}

export interface FlowNode {
  id: string
  label: string
  shape?: ShapeKind
  color?: BoardColor
}

export interface FlowEdge {
  from: string
  to: string
  label?: string
  style?: LineStyle
}

export interface FlowSpec {
  title?: string
  direction?: 'LR' | 'TB'
  /** Enclose the flow in a frame (default: true when there is a title). */
  frame?: boolean
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface BoardUpdate {
  id: string
  label?: string
  x?: number
  y?: number
  width?: number
  height?: number
  color?: BoardColor
}

export type BoardOp =
  | { op: 'read'; maxElements?: number }
  | { op: 'add'; elements: BoardAddElement[] }
  | { op: 'addFlow'; flow: FlowSpec }
  | { op: 'update'; updates: BoardUpdate[] }
  | { op: 'delete'; ids: string[] }

export interface BoardOpResult {
  ok: boolean
  /** Text returned to the model as the tool result (pt-BR, structured). */
  text: string
}

/** main -> renderer request for a board operation. */
export interface BoardRequest {
  requestId: string
  ideaId: number
  op: BoardOp
}
