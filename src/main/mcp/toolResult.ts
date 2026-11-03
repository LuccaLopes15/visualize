// Shared by the MCP tool modules (tools.ts, planTools.ts): the result shape of a
// tool call and the error → text conversion.
export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {})
})

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Runs a tool body; an unexpected throw becomes an `isError` result instead of a protocol error. */
export async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn()
  } catch (err) {
    return text(`Erro: ${errorMessage(err)}`, true)
  }
}
