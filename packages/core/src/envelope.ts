import { b64u, canonical, fromUtf8, unb64u, utf8 } from './bytes.ts'
import { open, paddedLength, randomId, seal, sign, verify } from './crypto.ts'
import type { Identity } from './identity.ts'

// What the relay sees: routing header plus ciphertext. It can't read or forge it.
export type Envelope = {
  v: 1
  id: string
  from: string
  to: string
  ts: number
  epk: string
  n: string
  ct: string
  sig: string
  // Set by the sender for messages that wait: the relay keeps a copy for each of
  // the recipient's devices that isn't online. Not signed; only the relay reads it.
  keep?: true
}

export const MAX_ENVELOPE_BYTES = 256 * 1024
// Queued envelopes can be days old, but nothing older than the relay TTL is valid.
export const MAX_ENVELOPE_AGE_MS = 8 * 24 * 3600 * 1000
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000

function header(e: Pick<Envelope, 'v' | 'id' | 'from' | 'to' | 'ts'>) {
  return { v: e.v, id: e.id, from: e.from, to: e.to, ts: e.ts }
}

function signedBytes(e: Omit<Envelope, 'sig'>): Uint8Array {
  return utf8(`quietsync/v1/env|${canonical({ ...header(e), epk: e.epk, n: e.n, ct: e.ct })}`)
}

export function sealEnvelope(
  me: Identity,
  to: { sign: string; box: string },
  payload: unknown,
  now = Date.now(),
): Envelope {
  const head = { v: 1 as const, id: randomId(), from: me.card.sign, to: to.sign, ts: now }
  const json = utf8(JSON.stringify(payload))
  const plain = new Uint8Array(paddedLength(json.length)).fill(0x20)
  plain.set(json)
  const sealed = seal(unb64u(to.box), plain, utf8(canonical(head)))
  const unsigned = { ...head, ...sealed }
  return { ...unsigned, sig: b64u(sign(signedBytes(unsigned), me.signing.priv)) }
}

export function isEnvelope(x: unknown): x is Envelope {
  if (!x || typeof x !== 'object') return false
  const e = x as Record<string, unknown>
  return (
    e.v === 1 &&
    ['id', 'from', 'to', 'epk', 'n', 'ct', 'sig'].every(k => typeof e[k] === 'string' && (e[k] as string).length > 0) &&
    typeof e.ts === 'number'
  )
}

export class EnvelopeError extends Error {}

// Verifies the sender's signature, then decrypts. Returns the raw payload for schema validation.
export function openEnvelope(me: Identity, env: Envelope, now = Date.now()): unknown {
  if (env.to !== me.card.sign) throw new EnvelopeError('not addressed to me')
  if (env.ts > now + MAX_CLOCK_SKEW_MS || env.ts < now - MAX_ENVELOPE_AGE_MS) throw new EnvelopeError('stale or future timestamp')
  const { sig, ...unsigned } = env
  if (!verify(unb64u(sig), signedBytes(unsigned), unb64u(env.from))) throw new EnvelopeError('bad signature')
  let plain: Uint8Array
  try {
    plain = open(me.box, env, utf8(canonical(header(env))))
  } catch {
    throw new EnvelopeError('decrypt failed')
  }
  return JSON.parse(fromUtf8(plain))
}
