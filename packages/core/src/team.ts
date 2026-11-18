import { b64u, canonical, unb64u, utf8 } from './bytes.ts'
import { digest, newSigningKey, randomId, sign, verify, type KeyPair } from './crypto.ts'
import { verifyCard, type Identity, type IdentityCard } from './identity.ts'
import type { ProfileChoice } from './profiles.ts'

// A team is self-certifying: its id is a hash of its public key, so a relay
// can't swap in a different team key for the same id.
//
// Joining takes two signatures. The joiner signs a membership using an invite
// capability; the team admin's quietsync then admits it, checking the
// capability's expiry and use count against its own clock and keeping handles
// unique. Clients only trust admitted members, so a leaked or expired code
// can't be replayed with a backdated join time.
export type TeamCard = { v: 1; teamId: string; name: string; pub: string; created: number; org?: string; sig: string }
export type InviteCap = { v: 1; teamId: string; inviteId: string; exp: number; max?: number; sig: string }
export type Membership = { v: 1; teamId: string; handle: string; card: IdentityCard; cap: InviteCap; joined: number; relay?: string; sig: string }
export type Admission = { v: 1; teamId: string; member: string; handle: string; inviteId: string; at: number; sig: string }
export type Revocation = { v: 1; teamId: string; member: string; at: number; sig: string }
// The profile a team's admin chose for its members, signed by the team key.
export type TeamPolicy = { v: 1; teamId: string; choice: ProfileChoice; at: number; sig: string }
export type TeamRecord =
  | { kind: 'card'; card: TeamCard }
  | { kind: 'member'; m: Membership }
  | { kind: 'admit'; a: Admission }
  | { kind: 'revoke'; r: Revocation }
  | { kind: 'policy'; p: TeamPolicy }

export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/

const bytesOf = (tag: string, body: unknown) => utf8(`quietsync/v1/${tag}|${canonical(body)}`)
const strip = <T extends { sig: string }>(x: T): Omit<T, 'sig'> => {
  const { sig: _sig, ...rest } = x
  return rest
}

export function teamIdFor(pub: Uint8Array): string {
  return b64u(digest(pub)).slice(0, 22)
}

export function createTeam(name: string, opts: { org?: string; now?: number } = {}): { card: TeamCard; key: KeyPair } {
  if (!HANDLE_RE.test(name)) throw new Error(`invalid team name "${name}"`)
  const key = newSigningKey()
  const body = { v: 1 as const, teamId: teamIdFor(key.pub), name, pub: b64u(key.pub), created: opts.now ?? Date.now(), ...(opts.org ? { org: opts.org } : {}) }
  return { key, card: { ...body, sig: b64u(sign(bytesOf('team', body), key.priv)) } }
}

export function verifyTeamCard(c: TeamCard): boolean {
  try {
    if (c.org !== undefined && (typeof c.org !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(c.org))) return false
    return c.v === 1 && HANDLE_RE.test(c.name) && c.teamId === teamIdFor(unb64u(c.pub)) && verify(unb64u(c.sig), bytesOf('team', strip(c)), unb64u(c.pub))
  } catch {
    return false
  }
}

export function issueCap(card: TeamCard, teamPriv: Uint8Array, ttlMs: number, opts: { max?: number; now?: number } = {}): InviteCap {
  const now = opts.now ?? Date.now()
  const body = { v: 1 as const, teamId: card.teamId, inviteId: randomId(9), exp: now + ttlMs, ...(opts.max ? { max: opts.max } : {}) }
  return { ...body, sig: b64u(sign(bytesOf('cap', body), teamPriv)) }
}

export function verifyCap(team: TeamCard, cap: InviteCap): boolean {
  try {
    return cap.v === 1 && cap.teamId === team.teamId && verify(unb64u(cap.sig), bytesOf('cap', strip(cap)), unb64u(team.pub))
  } catch {
    return false
  }
}

export function createMembership(me: Identity, card: TeamCard, cap: InviteCap, handle: string, opts: { relay?: string; now?: number } = {}): Membership {
  const now = opts.now ?? Date.now()
  if (!HANDLE_RE.test(handle)) throw new Error(`invalid handle "${handle}"`)
  if (cap.exp < now) throw new Error('team invite expired')
  const body = { v: 1 as const, teamId: card.teamId, handle, card: me.card, cap, joined: now, ...(opts.relay ? { relay: opts.relay } : {}) }
  return { ...body, sig: b64u(sign(bytesOf('member', body), me.signing.priv)) }
}

export function verifyMembership(team: TeamCard, m: Membership): boolean {
  try {
    if (m.v !== 1 || m.teamId !== team.teamId || !verifyCap(team, m.cap)) return false
    if (!HANDLE_RE.test(m.handle) || !verifyCard(m.card)) return false
    if (m.relay !== undefined && (typeof m.relay !== 'string' || !/^wss?:\/\//.test(m.relay) || m.relay.length > 300)) return false
    return verify(unb64u(m.sig), bytesOf('member', strip(m)), unb64u(m.card.sign))
  } catch {
    return false
  }
}

export function createAdmission(card: TeamCard, teamPriv: Uint8Array, m: Membership, now = Date.now()): Admission {
  const body = { v: 1 as const, teamId: card.teamId, member: m.card.sign, handle: m.handle, inviteId: m.cap.inviteId, at: now }
  return { ...body, sig: b64u(sign(bytesOf('admit', body), teamPriv)) }
}

export function verifyAdmission(team: TeamCard, a: Admission): boolean {
  try {
    return a.v === 1 && a.teamId === team.teamId && verify(unb64u(a.sig), bytesOf('admit', strip(a)), unb64u(team.pub))
  } catch {
    return false
  }
}

export function createRevocation(card: TeamCard, teamPriv: Uint8Array, member: string, now = Date.now()): Revocation {
  const body = { v: 1 as const, teamId: card.teamId, member, at: now }
  return { ...body, sig: b64u(sign(bytesOf('revoke', body), teamPriv)) }
}

export function verifyRevocation(team: TeamCard, r: Revocation): boolean {
  try {
    return r.teamId === team.teamId && verify(unb64u(r.sig), bytesOf('revoke', strip(r)), unb64u(team.pub))
  } catch {
    return false
  }
}

export function createTeamPolicy(card: TeamCard, teamPriv: Uint8Array, choice: ProfileChoice, now = Date.now()): TeamPolicy {
  const body = { v: 1 as const, teamId: card.teamId, choice, at: now }
  return { ...body, sig: b64u(sign(bytesOf('policy', body), teamPriv)) }
}

export function verifyTeamPolicy(team: TeamCard, p: TeamPolicy): boolean {
  try {
    return p.v === 1 && p.teamId === team.teamId && !!p.choice && typeof p.choice === 'object' && verify(unb64u(p.sig), bytesOf('policy', strip(p)), unb64u(team.pub))
  } catch {
    return false
  }
}

export type TeamState = { members: Membership[]; pending: Membership[]; policy: TeamPolicy | null }

// Turns raw directory records into verified members (admitted by the team key,
// handle matching the admission, not revoked) and pending joins. Anything that
// doesn't check out against the team key is dropped.
export function resolveTeamState(team: TeamCard, records: TeamRecord[]): TeamState {
  const revoked = new Set(records.flatMap(r => (r.kind === 'revoke' && verifyRevocation(team, r.r) ? [r.r.member] : [])))
  const admits = new Map<string, Admission>()
  for (const r of records) if (r.kind === 'admit' && verifyAdmission(team, r.a)) admits.set(r.a.member, r.a)
  const latest = new Map<string, Membership>()
  for (const r of records) {
    if (r.kind !== 'member' || !verifyMembership(team, r.m) || revoked.has(r.m.card.sign)) continue
    const prev = latest.get(r.m.card.sign)
    if (!prev || prev.joined < r.m.joined) latest.set(r.m.card.sign, r.m)
  }
  const members: Membership[] = []
  const pending: Membership[] = []
  const handles = new Set<string>()
  for (const m of [...latest.values()].sort((a, b) => (admits.get(a.card.sign)?.at ?? Infinity) - (admits.get(b.card.sign)?.at ?? Infinity))) {
    const a = admits.get(m.card.sign)
    if (a && a.handle === m.handle && a.inviteId === m.cap.inviteId && !handles.has(m.handle)) {
      members.push(m)
      handles.add(m.handle)
    } else {
      pending.push(m)
    }
  }
  let policy: TeamPolicy | null = null
  for (const r of records) if (r.kind === 'policy' && verifyTeamPolicy(team, r.p) && (!policy || r.p.at > policy.at)) policy = r.p
  return { members, pending, policy }
}

export function resolveTeam(team: TeamCard, records: TeamRecord[]): Membership[] {
  return resolveTeamState(team, records).members
}

// Admin side: which pending joins to admit right now.
export function admissible(state: TeamState, records: TeamRecord[], now = Date.now()): Membership[] {
  // Handles of removed members stay reserved, so nobody queued behind them can
  // inherit a name teammates already trust.
  const revoked = new Set(records.flatMap(r => (r.kind === 'revoke' ? [r.r.member] : [])))
  const reserved = records.flatMap(r => (r.kind === 'member' && revoked.has(r.m.card.sign) ? [r.m.handle] : []))
  const taken = new Set([...state.members.map(m => m.handle), ...reserved])
  const used = new Map<string, number>()
  for (const r of records) if (r.kind === 'admit') used.set(r.a.inviteId, (used.get(r.a.inviteId) ?? 0) + 1)
  const out: Membership[] = []
  for (const m of state.pending.sort((a, b) => a.joined - b.joined)) {
    if (m.cap.exp < now || taken.has(m.handle)) continue
    const n = used.get(m.cap.inviteId) ?? 0
    if (m.cap.max && n >= m.cap.max) continue
    used.set(m.cap.inviteId, n + 1)
    taken.add(m.handle)
    out.push(m)
  }
  return out
}

// Key a relay stores a record under; also what it checks the writer against.
export function recordKey(r: TeamRecord): string {
  if (r.kind === 'card') return 'card'
  if (r.kind === 'member') return `member:${r.m.card.sign}`
  if (r.kind === 'admit') return `admit:${r.a.member}`
  if (r.kind === 'policy') return 'policy'
  return `revoke:${r.r.member}`
}
