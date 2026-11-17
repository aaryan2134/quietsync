import { z } from 'zod'

export const MAX_TEXT = 16_000
export const MAX_TOPIC = 200
export const MAX_GROUP = 20

const Id = z.string().min(4).max(64).regex(/^[A-Za-z0-9_-]+$/)
const RelayUrl = z.string().max(300).regex(/^wss?:\/\//)
const Key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const TICKET_RE = /^[A-Z][A-Z0-9_]{0,15}-\d{1,9}$/
const Ticket = z.string().max(26).regex(TICKET_RE)
const LinkBox =z.object({ n: z.string().regex(/^[A-Za-z0-9_-]{32}$/), ct: z.string().min(22).max(90_000) })

const CardSchema = z.object({
  v: z.literal(1),
  name: z.string().max(32),
  sign: z.string().max(64),
  box: z.string().max(64),
  created: z.number(),
  sig: z.string().max(128),
})

export const SessionInfo = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(80),
  agent: z.string().max(32),
  device: z.string().max(64),
  // Their company keeps a sealed copy of the conversation.
  kept: z.boolean().optional(),
})
export type SessionInfo = z.infer<typeof SessionInfo>

// What the sending side's policy lets it do on this link, so the other side
// knows whether to expect replies.
const LinkCaps = z.object({ send: z.boolean(), receive: z.boolean() })
export type LinkCaps = z.infer<typeof LinkCaps>

// Reasons travel as codes. Free text here would be a channel the human never approves.
export const REASONS = {
  declined: 'declined',
  busy: 'busy right now',
  'not-accepting': 'not accepting links from you',
  done: 'done',
  ended: 'their session ended',
  taken: 'accepted in another session',
  idle: 'closed after being idle',
  flood: 'too many messages',
  human: 'closed by their human',
  withdrawn: 'withdrawn',
} as const
export type Reason = keyof typeof REASONS

export function reasonText(code: unknown): string {
  return typeof code === 'string' && code in REASONS ? REASONS[code as Reason] : 'closed'
}

// Every payload carries `sid`, the sending session, so sibling sessions of the
// same identity (several terminals, several devices) can tell links apart.
const base = { sid: z.string().min(1).max(64) }

export const Payload = z.discriminatedUnion('t', [
  z.object({ t: z.literal('pair.request'), ...base, inviteId: Id, proof: z.string().max(64), card: CardSchema, relay: RelayUrl.optional() }),
  z.object({ t: z.literal('pair.accept'), ...base, inviteId: Id, card: CardSchema, relay: RelayUrl.optional() }),
  z.object({ t: z.literal('pair.reject'), ...base, inviteId: Id, reason: z.string().max(200) }),
  z.object({
    t: z.literal('device.request'),
    ...base,
    inviteId: Id,
    proof: z.string().max(64),
    deviceName: z.string().max(64),
    card: CardSchema,
  }),
  z.object({ t: z.literal('device.grant'), ...base, inviteId: Id, bundle: z.string().max(200_000) }),
  z.object({
    t: z.literal('link.request'),
    ...base,
    linkId: Id,
    session: SessionInfo,
    topic: z.string().min(1).max(MAX_TOPIC),
    message: z.string().max(MAX_TEXT).optional(),
    caps: LinkCaps.optional(),
    group: z.object({ id: Id, size: z.number().int().min(2).max(MAX_GROUP) }).optional(),
    relay: RelayUrl.optional(),
    toSession: z.string().max(80).optional(),
    eph: Key32,
  }),
  z.object({ t: z.literal('link.accept'), ...base, linkId: Id, session: SessionInfo, caps: LinkCaps.optional(), relay: RelayUrl.optional(), eph: Key32 }),
  z.object({ t: z.literal('link.decline'), ...base, linkId: Id, reason: z.string().max(200).optional() }),
  z.object({ t: z.literal('link.claimed'), ...base, linkId: Id }),
  // Link messages are sealed again with the link's own keys (see crypto.linkKeys).
  z.object({ t: z.literal('link.msg'), ...base, linkId: Id, seq: z.number().int().min(1), box: LinkBox }),
  // A file: the offer travels like a message (its metadata and the file's own
  // key sealed with the link ratchet), then the chunks under that file key.
  z.object({ t: z.literal('link.file'), ...base, linkId: Id, seq: z.number().int().min(1), box: LinkBox }),
  z.object({
    t: z.literal('link.chunk'),
    ...base,
    linkId: Id,
    fileId: Id,
    index: z.number().int().min(0).max(1100),
    n: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    ct: z.string().min(22).max(140_000),
  }),
  z.object({ t: z.literal('link.ack'), ...base, linkId: Id, seq: z.number().int().min(1) }),
  z.object({ t: z.literal('link.close'), ...base, linkId: Id, reason: z.string().max(200).optional(), to: z.string().max(64).optional() }),
  // Messages wait at the relay for people who aren't online, unlike links.
  z.object({
    t: z.literal('note.msg'),
    ...base,
    noteId: Id,
    kind: z.enum(['ask', 'note', 'reply', 'request']),
    subject: z.string().max(MAX_TOPIC),
    text: z.string().min(1).max(MAX_TEXT),
    replyTo: Id.optional(),
    ticket: Ticket.optional(),
    session: SessionInfo,
    relay: RelayUrl.optional(),
  }),
  z.object({ t: z.literal('note.ack'), ...base, noteId: Id, state: z.enum(['delivered', 'seen', 'declined']) }),
  // New keys for the same person, sent under the old ones (a lost device, a rotation).
  z.object({ t: z.literal('id.rotate'), ...base, card: CardSchema }),
])
export type Payload = z.infer<typeof Payload>
export type PayloadOf<T extends Payload['t']> = Extract<Payload, { t: T }>
