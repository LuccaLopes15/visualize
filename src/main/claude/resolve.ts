// Finds the real Claude Code executable and checks version / login.
// Never goes through a shell: npm installs `claude.cmd` shims that just call
// `node_modules\@anthropic-ai\claude-code\bin\claude.exe` (or `cli.js` on old
// versions), so we read the shim and spawn its target directly. That avoids
// `shell: true` quoting pitfalls with spaces in paths, JSON and multi-line args.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { CLAUDE_MIN_VERSION, compareVersions, type ClaudeStatus } from '@shared/chat'
import { cleanClaudeEnv } from './env'

export interface ClaudeExecutable {
  /** Program to spawn (claude.exe, or node for a cli.js install). */
  command: string
  /** Arguments that go before the CLI's own (the cli.js path). */
  prefixArgs: string[]
  /** Extra env (ELECTRON_RUN_AS_NODE when Electron runs cli.js). */
  env: Record<string, string>
  /** What we show the user. */
  display: string
  source: 'setting' | 'path' | 'known'
}

const isWin = process.platform === 'win32'

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Extracts the target of an npm shim (.cmd / .ps1 / sh). */
export function parseShimTarget(shimPath: string, content: string): string | null {
  const dir = dirname(shimPath)
  const patterns = [
    /%~?dp0%?\\?([^"%\r\n]+?\.(?:exe|js|mjs|cjs))/i, // claude.cmd
    /\$basedir[\\/]([^"\r\n$]+?\.(?:exe|js|mjs|cjs))/i // claude (sh) / claude.ps1
  ]
  for (const re of patterns) {
    const m = re.exec(content)
    if (m) {
      const target = resolve(dir, m[1].replace(/^[\\/]+/, ''))
      if (isFile(target)) return target
    }
  }
  return null
}

function findNodeOnPath(): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, isWin ? 'node.exe' : 'node')
    if (isFile(candidate)) return candidate
  }
  return null
}

/** Turns any of: claude.exe, claude.cmd/.ps1/sh shim, cli.js into something spawnable. */
export function toExecutable(p: string, source: ClaudeExecutable['source']): ClaudeExecutable | null {
  if (!isFile(p)) return null
  const ext = extname(p).toLowerCase()
  if (ext === '.exe' || (!isWin && ext === '' && !looksLikeShim(p))) {
    return { command: p, prefixArgs: [], env: {}, display: p, source }
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const node = findNodeOnPath()
    if (node) return { command: node, prefixArgs: [p], env: {}, display: p, source }
    // No Node.js installed: Electron can run plain JS as Node.
    return { command: process.execPath, prefixArgs: [p], env: { ELECTRON_RUN_AS_NODE: '1' }, display: p, source }
  }
  // .cmd / .bat / .ps1 / extension-less sh shim
  let content = ''
  try {
    content = readFileSync(p, 'utf8')
  } catch {
    return null
  }
  const target = parseShimTarget(p, content)
  return target ? toExecutable(target, source) : null
}

function looksLikeShim(p: string): boolean {
  try {
    const head = readFileSync(p, { encoding: 'utf8', flag: 'r' }).slice(0, 200)
    return head.startsWith('#!') && /basedir/.test(readFileSync(p, 'utf8'))
  } catch {
    return false
  }
}

/** PATH lookup: native claude.exe first, then the npm shim. */
function fromPath(): ClaudeExecutable | null {
  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude']
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name)
      if (!isFile(candidate)) continue
      const exe = toExecutable(candidate, 'path')
      if (exe) return exe
    }
  }
  return null
}

function knownLocations(): string[] {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const appData = process.env['APPDATA'] ?? ''
  const local = process.env['LOCALAPPDATA'] ?? ''
  const bin = isWin ? 'claude.exe' : 'claude'
  const out: string[] = []
  if (home) out.push(join(home, '.local', 'bin', bin), join(home, '.claude', 'local', bin))
  if (appData) {
    out.push(
      join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      join(appData, 'npm', 'claude.cmd')
    )
  }
  if (local) out.push(join(local, 'Programs', 'claude', 'claude.exe'))
  return out
}

export interface ResolveResult {
  exe: ClaudeExecutable | null
  /** Set when the configured path is wrong. */
  settingProblem?: string
}

export function resolveClaude(settingPath: string): ResolveResult {
  const configured = settingPath.trim()
  if (configured) {
    if (!existsSync(configured)) {
      return { exe: null, settingProblem: `O caminho configurado não existe: ${configured}` }
    }
    const exe = toExecutable(configured, 'setting')
    return exe
      ? { exe }
      : { exe: null, settingProblem: `Não foi possível usar ${configured} como executável do Claude Code.` }
  }
  const fromPathExe = fromPath()
  if (fromPathExe) return { exe: fromPathExe }
  for (const p of knownLocations()) {
    const exe = toExecutable(p, 'known')
    if (exe) return { exe }
  }
  return { exe: null }
}

/** Runs the CLI with a few args and returns stdout (never throws). */
export function runClaude(
  exe: ClaudeExecutable,
  args: string[],
  timeoutMs = 15_000
): Promise<{ code: number | null; stdout: string; stderr: string; error?: Error }> {
  return new Promise((done) => {
    execFile(
      exe.command,
      [...exe.prefixArgs, ...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...cleanClaudeEnv(), ...exe.env },
        maxBuffer: 4 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0
        done({ code, stdout: String(stdout), stderr: String(stderr), error: error ?? undefined })
      }
    )
  })
}

export function parseVersion(output: string): string | null {
  const m = /(\d+\.\d+\.\d+)/.exec(output)
  return m ? m[1] : null
}

/** Parses `claude auth status` JSON output. */
export function parseAuthStatus(output: string): { loggedIn: boolean | null; account: string | null } {
  const start = output.indexOf('{')
  if (start < 0) return { loggedIn: null, account: null }
  try {
    const j = JSON.parse(output.slice(start)) as Record<string, unknown>
    const loggedIn = typeof j['loggedIn'] === 'boolean' ? (j['loggedIn'] as boolean) : null
    const plan = typeof j['subscriptionType'] === 'string' ? `Claude ${capitalize(j['subscriptionType'] as string)}` : ''
    const method = !plan && typeof j['authMethod'] === 'string' ? (j['authMethod'] as string) : ''
    const email = typeof j['email'] === 'string' ? (j['email'] as string) : ''
    const account = [plan || method, email].filter(Boolean).join(' · ') || null
    return { loggedIn, account }
  } catch {
    return { loggedIn: null, account: null }
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** Full detection: executable, version, login. Used by Configurações and the chat panel. */
export async function detectClaude(settingPath: string): Promise<ClaudeStatus & { exe: ClaudeExecutable | null }> {
  const base = { checkedAt: Date.now() }
  const { exe, settingProblem } = resolveClaude(settingPath)
  if (!exe) {
    return {
      ...base,
      exe: null,
      found: false,
      path: null,
      source: null,
      version: null,
      versionOk: false,
      loggedIn: null,
      account: null,
      problem: {
        code: 'not_found',
        message:
          settingProblem ??
          'Claude Code não encontrado. Instale com "npm install -g @anthropic-ai/claude-code" (ou o instalador oficial), faça login rodando "claude" no terminal e clique em Testar — ou informe o caminho do executável.'
      }
    }
  }
  const v = await runClaude(exe, ['--version'])
  const version = parseVersion(v.stdout)
  if (!version) {
    return {
      ...base,
      exe,
      found: true,
      path: exe.display,
      source: exe.source,
      version: null,
      versionOk: false,
      loggedIn: null,
      account: null,
      problem: {
        code: 'spawn',
        message: `Não foi possível executar ${exe.display} (${(v.error?.message ?? v.stderr).trim().slice(0, 300) || 'sem saída'}).`
      }
    }
  }
  const versionOk = compareVersions(version, CLAUDE_MIN_VERSION) >= 0
  const auth = versionOk ? parseAuthStatus((await runClaude(exe, ['auth', 'status'])).stdout) : { loggedIn: null, account: null }
  let problem: ClaudeStatus['problem'] = null
  if (!versionOk) {
    problem = {
      code: 'too_old',
      message: `Claude Code ${version} é antigo demais (mínimo ${CLAUDE_MIN_VERSION}). Atualize com "claude update" ou "npm install -g @anthropic-ai/claude-code".`
    }
  } else if (auth.loggedIn === false) {
    problem = {
      code: 'not_logged_in',
      message: 'O Claude Code não está logado. Abra um terminal, rode "claude" e faça login (/login); depois clique em Testar.'
    }
  }
  return {
    ...base,
    exe,
    found: true,
    path: exe.display,
    source: exe.source,
    version,
    versionOk,
    loggedIn: auth.loggedIn,
    account: auth.account,
    problem
  }
}
