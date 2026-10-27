/**
 * Environment for the spawned CLI. When Visualize itself runs inside another
 * Claude Code session (VS Code terminal, Claude Desktop, an agent running
 * `npm run dev`) it inherits variables such as CLAUDECODE=1 and
 * CLAUDE_CODE_COORDINATOR_MODE=1 that switch the child CLI into agent /
 * coordinator mode, where `--tools Read,Glob,Grep` ends up with no tools at
 * all (see docs/spike-fase3.md). Strip them, keeping credentials/provider
 * selection the user may have set on purpose.
 */
const KEEP = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS'
])

export function cleanClaudeEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue
    const k = key.toUpperCase()
    if (KEEP.has(k)) {
      env[key] = value
      continue
    }
    if (
      k === 'CLAUDECODE' ||
      k.startsWith('CLAUDE_CODE_') ||
      k.startsWith('CLAUDE_AGENT_SDK') ||
      k === 'CLAUDE_PID' ||
      k === 'CLAUDE_EFFORT' ||
      k.startsWith('CLAUDE_PREVIEW') ||
      k.startsWith('MCP_') ||
      k === 'ANTHROPIC_BASE_URL' ||
      k === 'ENABLE_COMMIT_REVIEW' ||
      k === 'ENABLE_CODE_SECURITY_REVIEW' ||
      // Electron dev-mode variables that make no sense for the child.
      k === 'ELECTRON_RUN_AS_NODE' ||
      k === 'ELECTRON_RENDERER_URL'
    )
      continue
    env[key] = value
  }
  return env
}
