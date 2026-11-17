import { b64u, fromUtf8, unb64u, utf8 } from './bytes.ts'
import { hmacSha256 } from './crypto.ts'
import { verifyCard, type IdentityCard } from './identity.ts'
import { verifyTeamCard, type InviteCap, type TeamCard } from './team.ts'

// Codes are pasted into Slack/email once, so they carry everything the other
// side needs: relay URL, the inviter's pinned card, and a one-time secret.
export type ContactInvite = { k: 'contact'; r: string; p: IdentityCard; i: string; s: string; e: number }
export type DeviceInvite = { k: 'device'; r: string; p: IdentityCard; i: string; s: string; e: number }
export type TeamInvite = { k: 'team'; r: string; team: TeamCard; cap: InviteCap }
export type Invite = ContactInvite | DeviceInvite | TeamInvite

const PREFIX = 'qs1_'

export function encodeInvite(inv: Invite): string {
  return PREFIX + b64u(utf8(JSON.stringify(inv)))
}

export function decodeInvite(code: string, now = Date.now()): Invite {
  const trimmed = code.trim()
  if (!trimmed.startsWith(PREFIX)) throw new Error('not a quietsync code (should start with qs1_)')
  let inv: Invite
  try {
    inv = JSON.parse(fromUtf8(unb64u(trimmed.slice(PREFIX.length))))
  } catch {
    throw new Error('code is damaged, copy it again')
  }
  if (typeof inv.r !== 'string' || !/^wss?:\/\//.test(inv.r)) throw new Error('code has no valid relay URL')
  if (inv.k === 'contact' || inv.k === 'device') {
    if (!verifyCard(inv.p)) throw new Error('code has an invalid identity card')
    if (inv.e < now) throw new Error('code expired, ask for a new one')
    return inv
  }
  if (inv.k === 'team') {
    if (!verifyTeamCard(inv.team)) throw new Error('code has an invalid team card')
    if (inv.cap.exp < now) throw new Error('team invite expired, ask for a new one')
    return inv
  }
  throw new Error('unknown code type')
}

export function inviteProof(kind: 'pair' | 'device', secret: string, inviteId: string, joinerSignPub: string): string {
  return b64u(hmacSha256(unb64u(secret), utf8(`quietsync/v1/${kind}|${inviteId}|${joinerSignPub}`)))
}
