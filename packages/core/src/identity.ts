import { b64u, canonical, unb64u, utf8 } from './bytes.ts'
import { newBoxKey, newSigningKey, sign, verify, type KeyPair } from './crypto.ts'

// The public half of an identity. Peers pin it at pairing time.
export type IdentityCard = {
  v: 1
  name: string
  sign: string
  box: string
  created: number
  sig: string
}

export type Identity = {
  name: string
  signing: KeyPair
  box: KeyPair
  card: IdentityCard
}

export type StoredIdentity = {
  v: 1
  name: string
  sign: { pub: string; priv: string }
  box: { pub: string; priv: string }
  card: IdentityCard
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/

export function validName(name: string): boolean {
  return NAME_RE.test(name)
}

function cardBody(card: Omit<IdentityCard, 'sig'>): Uint8Array {
  return utf8(`quietsync/v1/card|${canonical(card)}`)
}

export function createIdentity(name: string, now = Date.now()): Identity {
  if (!validName(name)) throw new Error(`invalid name "${name}": use lowercase letters, digits, . _ - (max 32)`)
  const signing = newSigningKey()
  const box = newBoxKey()
  const body = { v: 1 as const, name, sign: b64u(signing.pub), box: b64u(box.pub), created: now }
  return { name, signing, box, card: { ...body, sig: b64u(sign(cardBody(body), signing.priv)) } }
}

export function verifyCard(card: unknown): card is IdentityCard {
  if (!card || typeof card !== 'object') return false
  const c = card as IdentityCard
  if (c.v !== 1 || typeof c.name !== 'string' || !validName(c.name)) return false
  if (typeof c.sign !== 'string' || typeof c.box !== 'string' || typeof c.sig !== 'string') return false
  if (typeof c.created !== 'number') return false
  try {
    const { sig, ...body } = c
    return unb64u(c.box).length === 32 && verify(unb64u(sig), cardBody(body), unb64u(c.sign))
  } catch {
    return false
  }
}

export function serializeIdentity(id: Identity): StoredIdentity {
  return {
    v: 1,
    name: id.name,
    sign: { pub: b64u(id.signing.pub), priv: b64u(id.signing.priv) },
    box: { pub: b64u(id.box.pub), priv: b64u(id.box.priv) },
    card: id.card,
  }
}

export function deserializeIdentity(s: StoredIdentity): Identity {
  return {
    name: s.name,
    signing: { pub: unb64u(s.sign.pub), priv: unb64u(s.sign.priv) },
    box: { pub: unb64u(s.box.pub), priv: unb64u(s.box.priv) },
    card: s.card,
  }
}
