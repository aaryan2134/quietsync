# Protocol (v1)

What two implementations need to agree on. Source of truth: `packages/core/src`. Protocol v1 is stable as of QuietSync 1.0. Changes to anything here go through an [RFC](../rfcs/README.md); incompatible changes require a new protocol version, while receivers continue to ignore unknown optional fields.

## Encoding

- binary values are base64url without padding
- anything signed is serialized as canonical JSON (keys sorted, no whitespace, `undefined` dropped) behind a domain tag like `quietsync/v1/env|`

## Identity card

```json
{ "v": 1, "name": "alice", "sign": "<ed25519 pub>", "box": "<x25519 pub>", "created": 1761600000000, "sig": "<ed25519 over quietsync/v1/card|canonical(card minus sig)>" }
```

`name` matches `^[a-z0-9][a-z0-9._-]{0,31}$`. Fingerprint: first 16 symbols of base32(sha256(sign)), grouped by 4. Safety number for a pair: 6 groups of 5 digits from `sha256("quietsync/v1/sas|" + sorted(a,b).join("|"))`.

## Envelope

```json
{ "v": 1, "id": "<random>", "from": "<sender sign pub>", "to": "<recipient sign pub>", "ts": 1761600000000,
  "epk": "<ephemeral x25519 pub>", "n": "<24 byte nonce>", "ct": "<ciphertext>", "sig": "<ed25519>" }
```

- key = HKDF-SHA256(ikm = X25519(eph, recipient.box), salt = epk ‖ recipient.box, info = "quietsync/v1/seal", 32)
- ct = XChaCha20-Poly1305(key, n, aad = canonical({v,id,from,to,ts})).encrypt(JSON payload)
- sig = Ed25519 over `quietsync/v1/env|canonical({v,id,from,to,ts,epk,n,ct})`
- receivers reject: wrong `to`, bad signature, `ts` more than 10 min ahead or more than 8 days old, ids already seen
- the JSON plaintext is padded with spaces to 256, 512, 1024, 2048 or 4096 bytes, then multiples of 4096
- at most 256 KB serialized

## Link keys and messages

- `link.request` and `link.accept` each carry `eph`, a fresh X25519 public key for this link only
- both sides compute `okm = HKDF-SHA256(ikm = X25519(myEph, theirEph), salt = "quietsync/v1/link|" + linkId, info = initiatorSign + "|" + responderSign, 64)`; the first 32 bytes are the initiator-to-responder chain key, the rest the other direction
- for message `seq`, step the direction's chain from its last index to `seq`: `mk = HMAC-SHA256(ck, 0x01)`, `ck = HMAC-SHA256(ck, 0x02)`; skipped steps are discarded, at most 1000 at once
- `link.msg.box = { n, ct }` with `ct = XChaCha20-Poly1305(mk, n, aad = "quietsync/v1/msg|" + linkId + "|" + seq).encrypt(utf8 text)`
- a receiver commits the new chain state only after the message decrypts; ephemeral private keys and chain keys are zeroed when used up or when the link closes

## Payloads

All carry `t` and `sid` (the sending session). Text up to 16,000 characters, topics up to 200.

| t | fields | meaning |
|---|---|---|
| `pair.request` | inviteId, proof, card, relay? | proof = HMAC-SHA256(invite secret, `quietsync/v1/pair|inviteId|joiner sign pub`); relay = where to reach the joiner |
| `pair.accept` | inviteId, card, relay? | |
| `pair.reject` | inviteId, reason | |
| `device.request` | inviteId, proof, deviceName, card (temporary key) | |
| `device.grant` | inviteId, bundle | identity, contacts, teams, policy, sealed to the temporary key |
| `link.request` | linkId, session, topic, message?, caps?, group?, relay?, toSession?, eph | goes to every session of the recipient; `toSession` narrows it to sessions with that label |
| `link.accept` | linkId, session, caps?, relay?, eph | |
| `link.decline` | linkId, reason? | |
| `link.claimed` | linkId | to your own identity, so sibling sessions drop the request |
| `link.msg` | linkId, seq, box | seq strictly increasing per direction; a request's first message counts as seq 1 |
| `link.file` | linkId, seq, box | a file offer; `box` (ratcheted like a message) holds `{ fileId, name, kind, mime, size, sha256, chunks, key, note? }` |
| `link.chunk` | linkId, fileId, index, n, ct | `ct = XChaCha20-Poly1305(fileKey, n, aad = "quietsync/v1/chunk|" + linkId + "|" + fileId + "|" + index)` over at most 96 KB; the receiver checks the whole file against `sha256` |
| `link.ack` | linkId, seq | |
| `link.close` | linkId, reason?, to? | `to` targets one session of the recipient (used to turn away a second acceptor) |
| `note.msg` | noteId, kind (`ask`, `note`, `reply`), subject, text, replyTo?, ticket?, session, relay? | a message that waits; sealed to the recipient's long-term key, no link needed. `reply` must name an `ask` the receiver sent to this sender |
| `note.ack` | noteId, state (`delivered`, `seen`, `declined`) | receipts; `delivered` always, the others only if the receiver's profile sends receipts |

- `caps` is `{ send, receive }`: what the sender's policy lets it do on this link. Missing means both true.
- `group` is `{ id, size }` when the request is one of several sent together. Each member gets its own link; there's no member list on the wire.
- `relay` is the sender's home relay URL. Receivers may record it for that contact.
- `reason` is a code: `declined`, `busy`, `not-accepting`, `done`, `ended`, `taken`, `idle`, `flood`, `human`, `withdrawn`. Anything else is shown as "closed". Free text is not passed on.

Receivers handle link traffic only from contacts, admitted team members or their own identity; `link.msg`, `link.ack` and `link.close` only from the session that owns the link; and `link.request` only if its envelope is under 30 minutes old. `note.msg` is accepted up to 8 days old (the relay keeps queued envelopes 7).

## Invite codes

`qs1_` + base64url(JSON):

- contact: `{ k: "contact", r: relayUrl, p: inviterCard, i: inviteId, s: secret, e: expiry }`, single use
- device: same shape with `k: "device"`, short expiry, only honored while `device add` is running
- team: `{ k: "team", r, team: teamCard, cap }`, usable until `cap.exp`, by at most `cap.max` people if set

## Teams

- card: `{ v, teamId = base64url(sha256(teamPub))[0:22], name, pub, created, org?, sig }`, name matches the handle pattern; `org` = base64url(sha256("quietsync/v1/org|" + org plan id))[0:16]
- invite cap: `{ v, teamId, inviteId, exp, max?, sig by team key }`
- membership: `{ v, teamId, handle, card, cap, joined, relay?, sig by member }`
- admission: `{ v, teamId, member, handle, inviteId, at, sig by team key }`
- revocation: `{ v, teamId, member, at, sig by team key }`
- team profile: `{ v, teamId, choice: { profile?, features?, ceiling?, protect? }, at, sig by team key }`; the latest valid one by `at` applies

A member counts when its membership verifies, an admission for the same key and handle verifies against the team key, and it isn't revoked. Admins admit a pending membership only if, by their clock, the cap hasn't expired, its use count isn't reached, and the handle isn't held or previously held by a revoked member.

## Relay wire protocol

WebSocket at `/v1/ws`, subprotocol `quietsync.v1`, JSON text frames.

```
server: { t: "challenge", nonce }
client: { t: "auth", pub, sig: ed25519("quietsync/v1/relay-auth|" + nonce), ack?: true, device?: "<8-64 chars>" }
server: { t: "ready", member }, then queued { t: "env", env } if member
client: { t: "ack", ids: [envelope ids] }           (no response)
client: { t: "send", rid, env }                     → { t: "res", rid, ok, delivered, queued }
client: { t: "dir.put", rid, team, record }         → { t: "res", rid, ok }
client: { t: "dir.get", rid, team }                 → { t: "res", rid, ok, records }
any error                                           → { t: "res", rid, ok: false, error }
```

- `env.from` must equal the authenticated key
- delivery goes to every connection of `env.to` except the sender's own; with none online the envelope is queued
- a client that sends `ack: true` confirms each envelope after storing it. Until then the relay keeps it: queued rows stay, and envelopes handed to a socket that dies unconfirmed go back in the queue
- `device` is a stable random id per machine. An envelope with `keep: true` (messages that wait and their receipts) is also queued for each device of the recipient seen in the last 7 days that isn't online, and dropped once all of them have acked
- `keep` isn't covered by the envelope signature; only the relay reads it, and it tells the relay which envelopes are messages that wait
- a members-only relay gives non-members no mailbox, no queue and no directory; they may only send to members
- directory writes: a card only once per team and only if self-consistent; a membership only for your own key and only with an unexpired cap; admissions, revocations and team profiles only if signed by the team key
