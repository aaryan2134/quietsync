import type { Rel } from './policy.ts'
import type { PolicySubject } from './rules.ts'

// How much flows with a person without someone approving it, like Claude Code's
// permission modes. Set per contact, team or relationship; rules narrow or widen
// single kinds of message; an admin caps the highest mode.

export type Mode = 'ask' | 'review' | 'auto' | 'trusted'
export const MODES: Mode[] = ['ask', 'review', 'auto', 'trusted']

export const MODE_HELP: Record<Mode, string> = {
  ask: 'you approve every send, and their messages wait until you open them',
  review: 'you approve every send; their FYIs and answers go straight to your agent, their questions wait for you',
  auto: 'sends that pass the checks go without a dialog; FYIs and answers go to your agent, and it answers questions it can answer without you',
  trusted: 'everything flows both ways, including requests to do things; the safety checks and your agent permissions still apply',
}

export function isMode(m: unknown): m is Mode {
  return typeof m === 'string' && (MODES as string[]).includes(m)
}

export const modeRank = (m: Mode) => MODES.indexOf(m)
export const atLeast = (m: Mode, min: Mode) => modeRank(m) >= modeRank(min)
export const lowerMode = (a: Mode, b: Mode): Mode => (modeRank(a) <= modeRank(b) ? a : b)

export type MsgKind = 'fyi' | 'ask' | 'answer' | 'request'
export type Dir = 'in' | 'out'
export const MSG_KINDS: MsgKind[] = ['fyi', 'ask', 'answer', 'request']

// What happens to a kind of message with this person: it flows on its own, waits
// for a person, or is refused.
export type Flow = Record<Dir, Record<MsgKind, 'auto' | 'ask' | 'deny'>>

// The least mode in which each kind flows without a person.
const NEEDS: Record<Dir, Record<MsgKind, Mode>> = {
  in: { fyi: 'review', answer: 'review', ask: 'auto', request: 'trusted' },
  out: { fyi: 'auto', answer: 'auto', ask: 'auto', request: 'trusted' },
}

export const DEFAULT_MODE: Record<Rel, Mode> = { external: 'ask', team: 'review', self: 'trusted' }

export type Rules = { allow?: string[]; ask?: string[]; deny?: string[] }

// in:fyi(team:payments), answer(priya), out:*(external), send(dana), request(*)
const RULE = /^(?:(in|out):)?(\*|send|receive|fyi|ask|answer|request)(?:\(([^()]*)\))?$/

export function checkRule(rule: string): string | null {
  const m = RULE.exec(rule.trim())
  if (!m) return `"${rule}" isn't a rule. Use kind(who): kind is fyi, ask, answer, request, send, receive or *; who is a name, team:<name>, team, external, self or *. Prefix in: or out: for one direction.`
  if (m[1] && (m[2] === 'send' || m[2] === 'receive')) return `"${rule}": send and receive already say the direction`
  return null
}

function whoMatches(spec: string | undefined, who: PolicySubject): boolean {
  const s = (spec ?? '*').trim()
  if (!s || s === '*') return true
  if (s === 'team' || s === 'external' || s === 'self') return who.rel === s
  if (s.startsWith('team:')) return who.teams.some(t => t.name === s.slice(5) || t.id === s.slice(5))
  return s === who.id || s === who.name
}

function ruleMatches(rule: string, dir: Dir, kind: MsgKind, who: PolicySubject): boolean {
  const m = RULE.exec(rule.trim())
  if (!m) return false
  const [, d, k, spec] = m
  if (d && d !== dir) return false
  if (k === 'send' && dir !== 'out') return false
  if (k === 'receive' && dir !== 'in') return false
  if (k !== '*' && k !== 'send' && k !== 'receive' && k !== kind) return false
  return whoMatches(spec, who)
}

// deny beats ask beats allow, wherever each one comes from.
export function ruleVerdict(rules: Rules, dir: Dir, kind: MsgKind, who: PolicySubject): 'deny' | 'ask' | 'allow' | null {
  for (const v of ['deny', 'ask', 'allow'] as const) if (rules[v]?.some(r => ruleMatches(r, dir, kind, who))) return v
  return null
}

// An allow rule can't take a kind past what the cap lets flow on its own.
export function flowFor(mode: Mode, maxMode: Mode, rules: Rules, who: PolicySubject): Flow {
  const out = { in: {}, out: {} } as Flow
  for (const dir of ['in', 'out'] as const) {
    for (const kind of MSG_KINDS) {
      const need = NEEDS[dir][kind]
      const v = ruleVerdict(rules, dir, kind, who)
      out[dir][kind] = v === 'deny' ? 'deny' : v === 'ask' ? 'ask' : v === 'allow' ? (atLeast(maxMode, need) ? 'auto' : 'ask') : atLeast(mode, need) ? 'auto' : 'ask'
    }
  }
  return out
}

export function mergeRules(...sets: Array<Rules | undefined>): Rules {
  const out: Required<Rules> = { allow: [], ask: [], deny: [] }
  for (const s of sets) for (const k of ['allow', 'ask', 'deny'] as const) for (const r of s?.[k] ?? []) if (typeof r === 'string' && !checkRule(r) && !out[k].includes(r)) out[k].push(r)
  return out
}

// From a source that may only narrow (a team, an env file): its allow rules don't count.
export function narrowingRules(r: Rules | undefined): Rules {
  return { ask: r?.ask ?? [], deny: r?.deny ?? [] }
}

export function cleanRules(r: unknown): Rules | undefined {
  if (!r || typeof r !== 'object') return undefined
  const src = r as Record<string, unknown>
  const out: Rules = {}
  for (const k of ['allow', 'ask', 'deny'] as const) {
    if (Array.isArray(src[k])) out[k] = (src[k] as unknown[]).filter((x): x is string => typeof x === 'string' && x.length <= 120 && !checkRule(x)).slice(0, 200)
  }
  return out
}

// Which kind a stored message is, as rules and flows see it.
export function kindOf(noteKind: 'ask' | 'note' | 'reply' | 'request'): MsgKind {
  return noteKind === 'note' ? 'fyi' : noteKind === 'reply' ? 'answer' : noteKind
}
