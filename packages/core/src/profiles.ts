import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { b64u, utf8 } from './bytes.ts'
import { digest } from './crypto.ts'
import { cleanPatch, type PolicyPatch } from './rules.ts'
import { cleanRules, isMode, lowerMode, type Mode, type Rules } from './levels.ts'
import type { Rel } from './policy.ts'

// Profiles are named bundles of switches for three kinds of groups. Sources,
// strongest first: an admin's managed policy, the org plan you're signed into,
// your teams' published profiles, your own choice, then the built-in default.
// Teams and org plans can only take things away; the managed policy decides outright.

export type ProfileName = 'default' | 'company' | 'friends' | 'startup'
export type AuditLevel = 'full' | 'metadata' | 'off'

export type Features = {
  external: boolean
  orgOnly: boolean
  autoSend: boolean
  autoAccept: boolean
  secretsOverride: boolean
  requireVerified: boolean
  devices: boolean
  audit: AuditLevel
  auditDays: number
  shareDevice: boolean
  shareSession: boolean
  receipts: boolean
  files: boolean
  messages: boolean
  records: boolean
}

export type ProfileDef = {
  title: string
  summary: string
  security: 'standard' | 'low' | 'high'
  privacy: 'standard' | 'medium' | 'high'
  features: Features
  ceiling: PolicyPatch
  // Highest mode per relationship.
  modes: Partial<Record<Rel, Mode>>
  defaults: Record<string, PolicyPatch>
  protect: string[]
}

export const FEATURE_HELP: Record<keyof Features, string> = {
  external: 'pair and link with people outside your teams',
  orgOnly: "only link with people in your org's teams (and your own devices)",
  autoSend: 'auto-send may be turned on for a link or contact',
  autoAccept: 'auto-accept may be turned on for a contact',
  secretsOverride: 'a human may let secrets through on a link',
  requireVerified: 'outside contacts need a confirmed safety number before linking',
  devices: 'copy your identity to another machine',
  audit: 'what the local audit log keeps: full text, metadata only, or nothing',
  auditDays: 'days the audit log is kept',
  shareDevice: 'peers see your machine name',
  shareSession: 'peers see your session label (project folder name)',
  receipts: 'peers see when their messages reached you',
  files: 'send and receive files, zips and images (each send approved, received files quarantined)',
  messages: "messages that wait for people who aren't online, with delivered, seen and answered receipts",
  records: 'post copies of message threads to Slack, Jira, email or a webhook you set up',
}

const ALLOW_KEYS = ['external', 'autoSend', 'autoAccept', 'secretsOverride', 'devices', 'shareDevice', 'shareSession', 'receipts', 'files', 'messages', 'records'] as const
const REQUIRE_KEYS = ['orgOnly', 'requireVerified'] as const

// Personal folders: on a laptop that's also someone's own computer, keep the agent out of them while a peer is involved.
const PERSONAL = [
  '~/Documents/**',
  '~/Desktop/**',
  '~/Downloads/**',
  '~/Pictures/**',
  '~/Movies/**',
  '~/Library/Messages/**',
  '~/Library/Mail/**',
  '~/Library/Application Support/Google/Chrome/**',
  '~/Library/Application Support/Firefox/**',
  '~/Library/Group Containers/**',
  '~/.mozilla/**',
  '~/.config/google-chrome/**',
]

export const PROFILES: Record<ProfileName, ProfileDef> = {
  default: {
    title: 'default',
    summary: 'what you get without choosing: approve every link and send, secrets redacted, everything else up to you',
    security: 'standard',
    privacy: 'standard',
    features: {
      external: true,
      orgOnly: false,
      autoSend: true,
      autoAccept: true,
      secretsOverride: true,
      requireVerified: false,
      devices: true,
      audit: 'full',
      auditDays: 30,
      shareDevice: true,
      shareSession: true,
      receipts: true,
      files: true,
      messages: true,
      records: true,
    },
    ceiling: {},
    modes: {},
    defaults: {},
    protect: [],
  },
  company: {
    title: 'company',
    summary: 'people at one company: only colleagues, teammates up to auto mode, secrets blocked, records kept 90 days',
    security: 'high',
    privacy: 'medium',
    features: {
      external: false,
      orgOnly: true,
      autoSend: true,
      autoAccept: false,
      secretsOverride: false,
      requireVerified: false,
      devices: false,
      audit: 'full',
      auditDays: 90,
      shareDevice: true,
      shareSession: true,
      receipts: true,
      files: true,
      messages: true,
      records: true,
    },
    ceiling: { secrets: 'block', isolation: 'standard', autoSendLimit: 5, maxMessageChars: 8000, maxFileMB: 10 },
    modes: { team: 'auto', external: 'ask' },
    defaults: {},
    protect: [],
  },
  friends: {
    title: 'friends',
    summary: 'friends or classmates: anyone you pair with, conveniences allowed, no message text kept, machine and folder names hidden',
    security: 'low',
    privacy: 'high',
    features: {
      external: true,
      orgOnly: false,
      autoSend: true,
      autoAccept: true,
      secretsOverride: true,
      requireVerified: false,
      devices: true,
      audit: 'metadata',
      auditDays: 7,
      shareDevice: false,
      shareSession: false,
      receipts: false,
      files: true,
      messages: true,
      records: true,
    },
    ceiling: {},
    modes: {},
    defaults: { default: { maxFileMB: 25 }, external: { isolation: 'standard' } },
    protect: PERSONAL,
  },
  startup: {
    title: 'startup',
    summary: 'a small team on personal laptops: verified people only, teammates up to auto mode, outside people always asked, secrets blocked, personal folders off limits, no message text kept',
    security: 'high',
    privacy: 'high',
    features: {
      external: true,
      orgOnly: false,
      autoSend: true,
      autoAccept: false,
      secretsOverride: false,
      requireVerified: true,
      devices: true,
      audit: 'metadata',
      auditDays: 30,
      shareDevice: false,
      shareSession: false,
      receipts: false,
      files: true,
      messages: true,
      records: true,
    },
    ceiling: { secrets: 'block', isolation: 'standard', maxMessageChars: 8000, maxFileMB: 10 },
    modes: { team: 'auto', external: 'ask' },
    defaults: {},
    protect: PERSONAL,
  },
}

export function isProfile(name: unknown): name is ProfileName {
  return typeof name === 'string' && name in PROFILES
}

// A profile reference plus overrides, as a user, a team or an admin sets it.
export type ProfileChoice = { profile?: ProfileName; features?: Partial<Features>; ceiling?: PolicyPatch; modes?: Partial<Record<Rel, Mode>>; rules?: Rules; protect?: string[] }

export type FeatureSource = { label: string; kind: 'managed' | 'org' | 'team' | 'you' | 'default'; choice: ProfileChoice }

export type ResolvedFeatures = {
  features: Features
  from: Record<keyof Features, string>
  ceilings: PolicyPatch[]
  // Highest mode per relationship, the lowest any source sets.
  modes: Partial<Record<Rel, Mode>>
  defaults: Record<string, PolicyPatch>
  protect: string[]
  profile: string
}

function cleanFeatures(f: unknown): Partial<Features> {
  const out: Partial<Features> = {}
  if (!f || typeof f !== 'object') return out
  const src = f as Record<string, unknown>
  for (const k of [...ALLOW_KEYS, ...REQUIRE_KEYS]) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean
  if (src.audit === 'full' || src.audit === 'metadata' || src.audit === 'off') out.audit = src.audit
  if (typeof src.auditDays === 'number' && src.auditDays >= 1 && src.auditDays <= 3650) out.auditDays = Math.floor(src.auditDays)
  return out
}

// A choice from a team record or file: only well-formed parts count.
export function cleanChoice(c: unknown): ProfileChoice {
  if (!c || typeof c !== 'object') return {}
  const src = c as Record<string, unknown>
  const out: ProfileChoice = {}
  if (isProfile(src.profile)) out.profile = src.profile
  const f = cleanFeatures(src.features)
  if (Object.keys(f).length) out.features = f
  if (src.ceiling) out.ceiling = cleanPatch(src.ceiling)
  if (src.modes && typeof src.modes === 'object') {
    const m: Partial<Record<Rel, Mode>> = {}
    for (const r of ['external', 'team', 'self'] as const) if (isMode((src.modes as Record<string, unknown>)[r])) m[r] = (src.modes as Record<string, Mode>)[r]
    out.modes = m
  }
  const rules = cleanRules(src.rules)
  if (rules) out.rules = rules
  if (Array.isArray(src.protect)) out.protect = src.protect.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300).slice(0, 100)
  return out
}

function expand(choice: ProfileChoice): Partial<Features> {
  return { ...(isProfile(choice.profile) ? PROFILES[choice.profile].features : {}), ...cleanFeatures(choice.features) }
}

const DETAIL: Record<AuditLevel, number> = { off: 0, metadata: 1, full: 2 }

export function resolveFeatures(input: FeatureSource[]): ResolvedFeatures {
  const sources = input.map(s => ({ ...s, choice: cleanChoice(s.choice) }))
  const base = PROFILES.default.features
  const features = { ...base }
  const from = Object.fromEntries(Object.keys(base).map(k => [k, 'default'])) as Record<keyof Features, string>
  const managed = sources.find(s => s.kind === 'managed')
  const others = sources.filter(s => s.kind !== 'managed' && s.kind !== 'default')
  const expanded = others.map(s => ({ s, f: expand(s.choice) }))
  const m = managed ? expand(managed.choice) : {}

  for (const k of ALLOW_KEYS) {
    const set = expanded.filter(e => e.f[k] !== undefined)
    if (m[k] !== undefined) {
      features[k] = m[k]!
      from[k] = managed!.label
    } else if (set.length) {
      const off = set.find(e => e.f[k] === false)
      features[k] = !off
      from[k] = (off ?? set[0]!).s.label
    }
  }
  for (const k of REQUIRE_KEYS) {
    const set = expanded.filter(e => e.f[k] !== undefined)
    if (m[k] !== undefined) {
      features[k] = m[k]!
      from[k] = managed!.label
    } else if (set.length) {
      const on = set.find(e => e.f[k] === true)
      features[k] = !!on
      from[k] = (on ?? set[0]!).s.label
    }
  }
  // Records: whoever asks for the most detail wins, an admin decides outright.
  if (m.audit) {
    features.audit = m.audit
    features.auditDays = m.auditDays ?? features.auditDays
    from.audit = from.auditDays = managed!.label
  } else {
    const set = expanded.filter(e => e.f.audit)
    if (set.length) {
      const top = set.reduce((a, b) => (DETAIL[b.f.audit!] > DETAIL[a.f.audit!] ? b : a))
      features.audit = top.f.audit!
      const days = set.filter(e => e.f.audit === features.audit).map(e => e.f.auditDays ?? base.auditDays)
      features.auditDays = Math.max(...days)
      from.audit = from.auditDays = top.s.label
    }
  }
  // An org plan locks you to the org unless an admin explicitly lets people out.
  if (features.orgOnly && m.external !== true) {
    features.external = false
    if (from.external === 'default') from.external = from.orgOnly
  }

  const all = managed ? [...others, managed] : others
  const ceilings = all.flatMap(s => [isProfile(s.choice.profile) ? PROFILES[s.choice.profile].ceiling : {}, s.choice.ceiling ?? {}])
  const modes: Partial<Record<Rel, Mode>> = {}
  for (const src of all.flatMap(s => [isProfile(s.choice.profile) ? PROFILES[s.choice.profile].modes : {}, s.choice.modes ?? {}])) {
    for (const r of ['external', 'team', 'self'] as const) if (src[r]) modes[r] = modes[r] ? lowerMode(modes[r]!, src[r]!) : src[r]
  }
  const protect = [...new Set(all.flatMap(s => [...(isProfile(s.choice.profile) ? PROFILES[s.choice.profile].protect : []), ...(s.choice.protect ?? [])]))]
  const you = sources.find(s => s.kind === 'you')
  const mine = isProfile(you?.choice.profile) ? you!.choice.profile : undefined
  const named = managed?.choice.profile ?? mine ?? others.find(s => s.kind === 'org' && s.choice.profile)?.choice.profile
  return {
    features,
    from,
    ceilings,
    modes,
    defaults: isProfile(mine) ? PROFILES[mine].defaults : isProfile(named) ? PROFILES[named].defaults : {},
    protect,
    profile: isProfile(named) ? named : 'default',
  }
}

// ---- org plans -------------------------------------------------------------

export type OrgInfo = { id: string; name: string; plan: string; source: 'claude-code' | 'env' }

// The org a Claude Code login belongs to, if it's a Team or Enterprise plan.
// Personal plans have an org id too, so the plan type decides. QUIETSYNC_ORG_ID
// is for logins Claude Code can't tell us about (API keys, cloud providers); it
// never replaces an org plan the login does show, or it would let anyone
// rename their way out of the colleagues-only lock.
export function detectOrg(env: Record<string, string | undefined> = process.env): OrgInfo | null {
  try {
    const file = join(env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json')
    const acct = (JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: Record<string, unknown> }).oauthAccount
    const plan = String(acct?.organizationType ?? '')
    const id = acct?.organizationUuid
    if (typeof id === 'string' && id && /team|enterprise/i.test(plan)) {
      return { id, name: typeof acct?.organizationName === 'string' ? acct.organizationName : 'your org', plan, source: 'claude-code' }
    }
  } catch {}
  if (env.QUIETSYNC_ORG_ID) return { id: env.QUIETSYNC_ORG_ID, name: env.QUIETSYNC_ORG_NAME ?? env.QUIETSYNC_ORG_ID, plan: 'env', source: 'env' }
  return null
}

// What goes into a team card: a hash, so a relay doesn't learn the org's id.
export function orgTag(orgId: string): string {
  return b64u(digest(utf8(`quietsync/v1/org|${orgId}`))).slice(0, 16)
}

export function describeFeatures(r: ResolvedFeatures): string[] {
  return (Object.keys(r.features) as Array<keyof Features>).map(k => `${k.padEnd(16)} ${String(r.features[k]).padEnd(9)} ${r.from[k].padEnd(34)} ${FEATURE_HELP[k]}`)
}
