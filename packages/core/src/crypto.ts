import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { b64u, concat, unb64u, utf8 } from './bytes.ts'

export type KeyPair = { pub: Uint8Array; priv: Uint8Array }

export type Sealed = { epk: string; n: string; ct: string }

const SEAL_INFO = utf8('quietsync/v1/seal')

export { randomBytes }

export function newSigningKey(): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen()
  return { pub: publicKey, priv: secretKey }
}

export function newBoxKey(): KeyPair {
  const { secretKey, publicKey } = x25519.keygen()
  return { pub: publicKey, priv: secretKey }
}

export function boxKeyFromPriv(priv: Uint8Array): KeyPair {
  return { priv, pub: x25519.getPublicKey(priv) }
}

export function sign(message: Uint8Array, priv: Uint8Array): Uint8Array {
  return ed25519.sign(message, priv)
}

export function verify(sig: Uint8Array, message: Uint8Array, pub: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, pub)
  } catch {
    return false
  }
}

function sealKey(shared: Uint8Array, epk: Uint8Array, recipient: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(epk, recipient), SEAL_INFO, 32)
}

// Anonymous sealed box: ephemeral X25519 -> HKDF-SHA256 -> XChaCha20-Poly1305.
// Sender authenticity comes from the envelope signature, not from this layer.
export function seal(recipientBoxPub: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Sealed {
  const eph = newBoxKey()
  const key = sealKey(x25519.getSharedSecret(eph.priv, recipientBoxPub), eph.pub, recipientBoxPub)
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
  return { epk: b64u(eph.pub), n: b64u(nonce), ct: b64u(ct) }
}

export function open(box: KeyPair, sealed: Sealed, aad: Uint8Array): Uint8Array {
  const epk = unb64u(sealed.epk)
  const key = sealKey(x25519.getSharedSecret(box.priv, epk), epk, box.pub)
  return xchacha20poly1305(key, unb64u(sealed.n), aad).decrypt(unb64u(sealed.ct))
}

// Per-link keys from both sides' ephemeral X25519 keys. They live only in
// memory for the life of the link, so stealing an identity key later doesn't
// open recorded link traffic (forward secrecy per link).
export function linkKeys(
  myEphPriv: Uint8Array,
  theirEphPub: Uint8Array,
  ctx: { linkId: string; initiator: string; responder: string; iAmInitiator: boolean },
): { send: Uint8Array; recv: Uint8Array } {
  const shared = x25519.getSharedSecret(myEphPriv, theirEphPub)
  if (shared.every(b => b === 0)) throw new Error('bad ephemeral key')
  const okm = hkdf(sha256, shared, utf8(`quietsync/v1/link|${ctx.linkId}`), utf8(`${ctx.initiator}|${ctx.responder}`), 64)
  shared.fill(0)
  const i2r = okm.slice(0, 32)
  const r2i = okm.slice(32)
  okm.fill(0)
  return ctx.iAmInitiator ? { send: i2r, recv: r2i } : { send: r2i, recv: i2r }
}

// Symmetric ratchet inside a link: each message key comes from a chain key
// that moves forward and is overwritten, so a key taken from memory later
// can't decrypt messages that were already sent or received.
export function ratchet(chain: Uint8Array, index: number, seq: number): { mk: Uint8Array; chain: Uint8Array } {
  if (seq <= index || seq - index > 1000) throw new Error('message out of range')
  let ck = chain
  let mk = new Uint8Array(32)
  for (let i = index; i < seq; i++) {
    mk.fill(0)
    mk = hmac(sha256, ck, new Uint8Array([1]))
    const next = hmac(sha256, ck, new Uint8Array([2]))
    if (ck !== chain) ck.fill(0)
    ck = next
  }
  return { mk, chain: ck }
}

export type LinkBox = { n: string; ct: string }

const msgAad = (linkId: string, seq: number) => utf8(`quietsync/v1/msg|${linkId}|${seq}`)

export function boxLinkText(key: Uint8Array, linkId: string, seq: number, text: string): LinkBox {
  const nonce = randomBytes(24)
  return { n: b64u(nonce), ct: b64u(xchacha20poly1305(key, nonce, msgAad(linkId, seq)).encrypt(utf8(text))) }
}

export function openLinkText(key: Uint8Array, linkId: string, seq: number, box: LinkBox): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(xchacha20poly1305(key, unb64u(box.n), msgAad(linkId, seq)).decrypt(unb64u(box.ct)))
}

// File chunks are sealed with a key made for that one file, carried inside the
// ratcheted offer. The aad pins each chunk to its link, file and position.
const chunkAad = (linkId: string, fileId: string, index: number) => utf8(`quietsync/v1/chunk|${linkId}|${fileId}|${index}`)

export function sealChunk(key: Uint8Array, linkId: string, fileId: string, index: number, data: Uint8Array): { n: string; ct: string } {
  const nonce = randomBytes(24)
  return { n: b64u(nonce), ct: b64u(xchacha20poly1305(key, nonce, chunkAad(linkId, fileId, index)).encrypt(data)) }
}

export function openChunk(key: Uint8Array, linkId: string, fileId: string, index: number, n: string, ct: string): Uint8Array {
  return xchacha20poly1305(key, unb64u(n), chunkAad(linkId, fileId, index)).decrypt(unb64u(ct))
}

// Plaintext is padded with spaces (valid trailing JSON whitespace) to one of a
// few sizes, so a relay or network observer learns less from message lengths.
export function paddedLength(n: number): number {
  for (const b of [256, 512, 1024, 2048, 4096]) if (n <= b) return b
  return Math.ceil(n / 4096) * 4096
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message)
}

export function digest(data: Uint8Array): Uint8Array {
  return sha256(data)
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function randomId(bytes = 12): string {
  return b64u(randomBytes(bytes))
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

// Human-comparable short form of a public key, e.g. "K7QF-3MZP-X2AB-9HCT".
export function fingerprint(pubB64u: string): string {
  const h = sha256(unb64u(pubB64u))
  let out = ''
  for (let i = 0; i < 16; i++) out += B32[h[i]! % 32]
  return out.match(/.{4}/g)!.join('-')
}

// Signal-style safety number both people can read out loud to confirm a pairing.
export function safetyNumber(aB64u: string, bB64u: string): string {
  const [x, y] = [aB64u, bB64u].sort()
  const h = sha256(utf8(`quietsync/v1/sas|${x}|${y}`))
  const groups: string[] = []
  for (let i = 0; i < 6; i++) {
    const n = ((h[i * 3]! << 16) | (h[i * 3 + 1]! << 8) | h[i * 3 + 2]!) % 100000
    groups.push(String(n).padStart(5, '0'))
  }
  return groups.join(' ')
}

const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

// Short code a human types; 'l' is left out so it never reads as 1 or I.
export function shortCode(length = 5): string {
  let out = ''
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      // 250 is the largest multiple of 25 under 256, so no modulo bias
      if (b < 250 && out.length < length) out += CODE_ALPHABET[b % 25]
    }
  }
  return out
}
