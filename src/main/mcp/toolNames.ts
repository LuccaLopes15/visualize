// Every tool the "visualize" MCP server registers. The CLI runner builds its
// --allowedTools from this list (src/main/claude/args.ts); mcp.test.ts checks it
// matches what the server really exposes, so a new tool can't be silently denied.
export const VISUALIZE_TOOL_NAMES = [
  'board_read',
  'board_add',
  'board_add_flow',
  'board_update',
  'board_delete',
  'macro_read',
  'macro_write',
  'macro_append_section',
  'tasks_read',
  'tasks_replace_all',
  'tasks_add',
  'tasks_update_node',
  'tasks_set_parent',
  'tasks_reorder',
  'tasks_add_dep',
  'tasks_remove_dep',
  'tasks_delete_node'
] as const

export const MCP_TOOL_PREFIX = 'mcp__visualize__'

export const visualizeAllowedTools = (): string[] => VISUALIZE_TOOL_NAMES.map((n) => MCP_TOOL_PREFIX + n)
