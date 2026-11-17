import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rel } from './policy.ts'
import type { Features, ProfileName } from './profiles.ts'
import { DEFAULT_MODE, flowFor, isMode, lowerMode, mergeRules, modeRank, type Flow, type Mode, type Rules } from './levels.ts'

// What a person allows on links with a peer, and how much they want to see.
// Layers, most general first: built-in defaults, the user's `default`, the
// relationship (`external` / `team` / `self`), each team the peer is in, the
// contact itself. Later layers override earlier ones; all of them are the
// human's own choices. Then two clamps that can only narrow: the session's
// mode and an admin's managed policy.

export type Role = 'peer' | 'asker' | 'responder' | 'listener' | 'notifier' | 'off'
export type Caps = { initiate: boolean; accept: boolean; send: boolean; receive: boolean }
export type Approval = 'ask' | 'auto'
export type Isolation = 'relaxed' | 'standard' | 'strict'
export type SecretMode = 'block' | 'redact'

export type Policy = {
  role: Role
  caps: Caps
  links: Approval
  send: Approval
  isolation: Isolation
  secrets: SecretMode
  autoSendLimit: number
  maxMessageChars: number
  maxFileMB: number
  // How much flows without a person approving it, the highest an admin or
  // profile lets it go, and what that means for each kind of message.
  mode: Mode
  maxMode: Mode
  flow: Flow
  // Set when a profile or org rule keeps this person out entirely; says why.
  blockedBy?: string
}

export type PolicyPatch = Partial<Omit<Policy, 'caps' | 'flow' | 'maxMode'>> & { caps?: Partial<Caps> }

export type DlpConfig = { block?: string[]; warn?: string[]; terms?: string[] }

export type PolicyFile = {
  profile?: ProfileName
  features?: Partial<Features>
  default?: PolicyPatch
  external?: PolicyPatch
  team?: PolicyPatch
  self?: PolicyPatch
  teams?: Record<string, PolicyPatch>
  contacts?: Record<string, PolicyPatch>
  dlp?: DlpConfig
  rules?: Rules
  protect?: string[]
  allowPaths?: string[]
  maxLinks?: number
  inbox?: string
  wakeLimit?: number
  inboundPerMinute?: number
  allowInsecureRelays?: boolean
}

export type ManagedPolicy = {
  profile?: ProfileName
  features?: Partial<Features>
  // Teams that count as the org's. Without it, teams carrying your org plan's tag count.
  org?: { teams?: string[] }
  ceiling?: PolicyPatch
  // Highest mode per relationship, for example { "team": "auto", "external": "ask" }.
  modes?: Partial<Record<Rel, Mode>>
  rules?: Rules
  // A sealed copy of every message for the company (see journal.ts).
  journal?: { key: string; dir?: string; url?: string }
  allowExternal?: boolean
  allowSecretsOverride?: boolean
  allowRelays?: string[]
  dlp?: DlpConfig
  protect?: string[]
  maxLinks?: number
}

export const ROLES: Record<Role, Caps> = {
  peer: { initiate: true, accept: true, send: true, receive: true },
  asker: { initiate: true, accept: false, send: true, receive: true },
  responder: { initiate: false, accept: true, send: true, receive: true },
  listener: { initiate: false, accept: true, send: false, receive: true },
  notifier: { initiate: true, accept: false, send: true, receive: false },
  off: { initiate: false, accept: false, send: false, receive: false },
}

export const ROLE_HELP: Record<Role, string> = {
  peer: 'two-way: either side can start links and both can talk',
  asker: 'you can start links and talk, they cannot start links with you',
  responder: 'they can start links with you and you answer, you never start',
  listener: 'they can start links and send, your agent reads but never replies',
  notifier: 'you start links and send, their replies are dropped',
  off: 'nothing in either direction',
}

export const DEFAULT_POLICY: Policy = {
  role: 'peer',
  caps: ROLES.peer,
  links: 'ask',
  send: 'ask',
  isolation: 'standard',
  secrets: 'redact',
  autoSendLimit: 10,
  maxMessageChars: 8000,
  maxFileMB: 10,
  mode: 'ask',
  maxMode: 'trusted',
  flow: flowFor('ask', 'trusted', {}, { id: '', rel: 'external', teams: [] }),
}

// Built-in starting points per relationship. External peers get strict
// isolation: the link keeps the session in "peer involved" mode until it closes.
const BUILTIN_REL: Record<Rel, PolicyPatch> = {
  external: { isolation: 'strict', mode: DEFAULT_MODE.external },
  team: { mode: DEFAULT_MODE.team },
  self: { mode: DEFAULT_MODE.self },
}

const ISOLATION_RANK: Record<Isolation, number> = { relaxed: 0, standard: 1, strict: 2 }

export function stricterIsolation(a: Isolation, b: Isolation): Isolation {
  return ISOLATION_RANK[a] >= ISOLATION_RANK[b] ? a : b
}

function apply(base: Policy, p: PolicyPatch | undefined): Policy {
  if (!p) return base
  const out: Policy = { ...base, caps: { ...base.caps } }
  if (p.role && p.role in ROLES) {
    out.role = p.role
    out.caps = { ...ROLES[p.role] }
  }
  if (p.caps) for (const k of Object.keys(out.caps) as Array<keyof Caps>) if (typeof p.caps[k] === 'boolean') out.caps[k] = p.caps[k]!
  if (p.links === 'ask' || p.links === 'auto') out.links = p.links
  if (p.send === 'ask' || p.send === 'auto') out.send = p.send
  if (p.isolation && p.isolation in ISOLATION_RANK) out.isolation = p.isolation
  if (p.secrets === 'block' || p.secrets === 'redact') out.secrets = p.secrets
  if (Number.isFinite(p.autoSendLimit)) out.autoSendLimit = Math.max(0, Math.floor(p.autoSendLimit!))
  if (Number.isFinite(p.maxMessageChars)) out.maxMessageChars = Math.min(16_000, Math.max(200, Math.floor(p.maxMessageChars!)))
  if (Number.isFinite(p.maxFileMB)) out.maxFileMB = Math.min(50, Math.max(0, p.maxFileMB!))
  if (isMode(p.mode)) out.mode = lowerMode(p.mode, out.maxMode)
  return out
}

// Narrowing only: a clamp can take capabilities and auto-approvals away, never add them.
export function clamp(base: Policy, c: PolicyPatch | undefined): Policy {
  if (!c || typeof c !== 'object') return base
  const out: Policy = { ...base, caps: { ...base.caps } }
  const capsLimit = c.role && c.role in ROLES ? ROLES[c.role] : undefined
  for (const k of Object.keys(out.caps) as Array<keyof Caps>) {
    if (capsLimit && !capsLimit[k]) out.caps[k] = false
    if (c.caps?.[k] === false) out.caps[k] = false
  }
  if (c.links === 'ask') out.links = 'ask'
  if (c.send === 'ask') out.send = 'ask'
  // A clamp that names a mode caps it, and below auto nothing goes unattended,
  // below trusted no link is accepted on its own. One that only says no
  // unattended sends caps it at review; no automatic links, at auto.
  if (isMode(c.mode)) {
    out.maxMode = lowerMode(out.maxMode, c.mode)
    if (modeRank(out.maxMode) < modeRank('auto')) out.send = 'ask'
    if (modeRank(out.maxMode) < modeRank('trusted')) out.links = 'ask'
  } else {
    if (c.send === 'ask') out.maxMode = lowerMode(out.maxMode, 'review')
    if (c.links === 'ask') out.maxMode = lowerMode(out.maxMode, 'auto')
  }
  out.mode = lowerMode(out.mode, out.maxMode)
  if (c.isolation && c.isolation in ISOLATION_RANK) out.isolation = stricterIsolation(out.isolation, c.isolation)
  if (c.secrets === 'block') out.secrets = 'block'
  if (Number.isFinite(c.autoSendLimit)) out.autoSendLimit = Math.min(out.autoSendLimit, c.autoSendLimit!)
  if (Number.isFinite(c.maxMessageChars)) out.maxMessageChars = Math.min(out.maxMessageChars, c.maxMessageChars!)
  if (Number.isFinite(c.maxFileMB)) out.maxFileMB = Math.min(out.maxFileMB, Math.max(0, c.maxFileMB!))
  out.role = roleOf(out.caps)
  return out
}

export function roleOf(caps: Caps): Role {
  for (const [role, c] of Object.entries(ROLES) as Array<[Role, Caps]>) {
    if (c.initiate === caps.initiate && c.accept === caps.accept && c.send === caps.send && c.receive === caps.receive) return role
  }
  return 'peer'
}

export type PolicySubject = { id: string; rel: Rel; teams: Array<{ id: string; name: string; org?: boolean }>; name?: string; verified?: boolean }

export function withFlow(p: Policy, rules: Rules, who: PolicySubject): Policy {
  return { ...p, flow: flowFor(p.mode, p.maxMode, rules, who) }
}

export function resolvePolicy(
  file: PolicyFile,
  managed: ManagedPolicy | null,
  who: PolicySubject,
  session?: PolicyPatch,
  profileDefaults: Record<string, PolicyPatch> = {},
): Policy {
  let p = apply(apply(DEFAULT_POLICY, BUILTIN_REL[who.rel]), profileDefaults.default)
  p = apply(apply(p, profileDefaults[who.rel]), file.default)
  p = apply(p, file[who.rel])
  // A peer in several teams gets the strictest of the team rules.
  const teamPatches = who.teams.map(t => file.teams?.[t.name] ?? file.teams?.[t.id]).filter(Boolean) as PolicyPatch[]
  if (teamPatches.length === 1) p = apply(p, teamPatches[0])
  else if (teamPatches.length > 1) p = teamPatches.slice(1).reduce<Policy>((acc, t) => clamp(acc, t), apply(p, teamPatches[0]))
  p = apply(p, file.contacts?.[who.id])
  p = clamp(p, session)
  if (managed) {
    if (who.rel === 'external' && managed.allowExternal === false) p = clamp(p, { role: 'off' })
    p = clamp(p, managed.ceiling)
    const cap = managed.modes?.[who.rel]
    if (isMode(cap)) p = clamp(p, { mode: cap })
  }
  return withFlow(p, mergeRules(managed?.rules, file.rules), who)
}

// True when `next` allows something `prev` didn't. Loosening needs a human
// at a real input (band button, TTY confirm), never the agent.
export function loosens(prev: Policy, next: Policy): boolean {
  for (const k of Object.keys(prev.caps) as Array<keyof Caps>) if (!prev.caps[k] && next.caps[k]) return true
  if (prev.links === 'ask' && next.links === 'auto') return true
  if (prev.send === 'ask' && next.send === 'auto') return true
  if (ISOLATION_RANK[next.isolation] < ISOLATION_RANK[prev.isolation]) return true
  if (next.autoSendLimit > prev.autoSendLimit && next.send === 'auto') return true
  if (modeRank(next.mode) > modeRank(prev.mode)) return true
  for (const d of ['in', 'out'] as const) for (const k of Object.keys(prev.flow[d]) as Array<keyof Flow['in']>) if (prev.flow[d][k] !== 'auto' && next.flow[d][k] === 'auto') return true
  return false
}

export function describePolicy(p: Policy): string {
  const caps = [
    p.caps.initiate ? 'can start links' : 'never starts links',
    p.caps.accept ? 'accepts requests' : 'refuses requests',
    p.caps.send ? 'can send' : 'never sends',
    p.caps.receive ? 'reads replies' : 'drops replies',
  ]
  return `${p.role} (${caps.join(', ')}); mode ${p.mode}${p.maxMode !== 'trusted' ? ` (up to ${p.maxMode})` : ''}, links ${p.links}, sends ${p.send}, isolation ${p.isolation}, secrets ${p.secrets}`
}

// Keeps only well-formed fields of a patch that came from somewhere we don't
// fully control (a team's published profile, an env-supplied file).
export function cleanPatch(p: unknown): PolicyPatch {
  if (!p || typeof p !== 'object') return {}
  const src = p as Record<string, unknown>
  const out: PolicyPatch = {}
  if (typeof src.role === 'string' && src.role in ROLES) out.role = src.role as Role
  if (src.caps && typeof src.caps === 'object') {
    const caps: Partial<Caps> = {}
    for (const k of ['initiate', 'accept', 'send', 'receive'] as const) if (typeof (src.caps as Record<string, unknown>)[k] === 'boolean') caps[k] = (src.caps as Record<string, boolean>)[k]
    out.caps = caps
  }
  if (src.links === 'ask' || src.links === 'auto') out.links = src.links
  if (src.send === 'ask' || src.send === 'auto') out.send = src.send
  if (typeof src.isolation === 'string' && src.isolation in ISOLATION_RANK) out.isolation = src.isolation as Isolation
  if (src.secrets === 'block' || src.secrets === 'redact') out.secrets = src.secrets
  if (typeof src.autoSendLimit === 'number' && Number.isFinite(src.autoSendLimit)) out.autoSendLimit = src.autoSendLimit
  if (typeof src.maxMessageChars === 'number' && Number.isFinite(src.maxMessageChars)) out.maxMessageChars = src.maxMessageChars
  if (typeof src.maxFileMB === 'number' && Number.isFinite(src.maxFileMB)) out.maxFileMB = src.maxFileMB
  if (isMode(src.mode)) out.mode = src.mode
  return out
}

// Where IT puts the managed policy. A user-set QUIETSYNC_MANAGED_POLICY is only
// read when this file doesn't exist (testing, machines without MDM), so it can
// never override what an admin deployed.
export function managedPolicyPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/quietsync/managed.json'
  if (process.platform === 'win32') return join(process.env.ProgramData ?? 'C:\\ProgramData', 'quietsync', 'managed.json')
  return '/etc/quietsync/managed.json'
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function loadManagedPolicy(): ManagedPolicy | null {
  return readJson<ManagedPolicy>(managedPolicyPath())
}

// The env-supplied file is for testing and machines without device management.
// Anyone can set an env var, so it only ever narrows; see Policies.sources().
export function loadEnvPolicy(): ManagedPolicy | null {
  const path = process.env.QUIETSYNC_MANAGED_POLICY
  return path && path !== managedPolicyPath() ? readJson<ManagedPolicy>(path) : null
}

const RELAY_LOCAL = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//

export function checkRelayUrl(url: string, opts: { allowInsecure?: boolean; allowRelays?: string[] } = {}): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `"${url}" is not a URL`
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return `relay must be a ws:// or wss:// URL, got ${u.protocol}`
  if (u.username || u.password) return 'relay URL must not carry credentials'
  if (u.protocol === 'ws:' && !RELAY_LOCAL.test(url) && !opts.allowInsecure) {
    return `refusing unencrypted relay ${url}: use wss://, or set allowInsecureRelays in policy.json for a trusted LAN`
  }
  if (opts.allowRelays?.length && !opts.allowRelays.some(a => url === a || url.startsWith(a.endsWith('/') ? a : `${a}/`))) {
    return `relay ${url} is not on your organization's allowed list`
  }
  return null
}
