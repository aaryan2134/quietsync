import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { b64u, unb64u } from './bytes.ts'
import { boxLinkText, constantTimeEqual, fingerprint, linkKeys, newBoxKey, openChunk, openLinkText, randomBytes, randomId, ratchet, safetyNumber, sealChunk } from './crypto.ts'
import { CHUNK_BYTES, describeIncoming, formatSize, inspectOutgoing, readZip, safeFileName, sha256Hex, sniff, type FileKind, type Inspection } from './files.ts'
import { cleanOutbound, prepareOutbound, scanSecrets, describeFindings, type Outbound } from './dlp.ts'
import { EnvelopeError, isEnvelope, openEnvelope, sealEnvelope, type Envelope } from './envelope.ts'
import { frameAccepted, frameAnswer, frameClosed, frameDeclined, frameFile, frameMessage, frameNote, frameRequest } from './frame.ts'
import { createIdentity, serializeIdentity, deserializeIdentity, verifyCard, type Identity, type IdentityCard, type StoredIdentity } from './identity.ts'
import { decodeInvite, encodeInvite, inviteProof, type ContactInvite, type DeviceInvite } from './invite.ts'
import { MAX_GROUP, Payload, reasonText, TICKET_RE, type LinkCaps, type PayloadOf, type Reason, type SessionInfo } from './messages.ts'
import { Policies } from './policies.ts'
import type { GroupView, LinkView, OutgoingView, PeerView, ProfileView, Rel, RequestView, SendPolicy, SessionView } from './policy.ts'
import { RelayPool, type RelayClient } from './relay-client.ts'
import { ROLE_HELP, ROLES, type Approval, type Isolation, type Policy, type PolicyFile, type Role } from './rules.ts'
import { atLeast, kindOf, type Mode } from './levels.ts'
import { Journal } from './journal.ts'
import { isSuspicious, sanitizeInbound, sanitizeLabel } from './sanitize.ts'
import { contactLabel, Store, type Config, type Contact, type StoredTeam } from './store.ts'
import { admissible, createAdmission, createMembership, createRevocation, createTeam, createTeamPolicy, issueCap, resolveTeamState, verifyTeamCard } from './team.ts'
import type { ProfileChoice } from './profiles.ts'
import { advance, answerable, expire, fitsBand, MAX_NEW_PER_PEER, stalePending, MAX_NEW_TOTAL, noteKey, prune, QUEUE_TTL_MS, type Note, type NoteKind, type NoteState, type NoteView, type Thread } from './notes.ts'

export type NodeEvent =
  | { kind: 'request'; requestId: string; peer: PeerView; topic: string; message?: string; flags: string[] }
  | { kind: 'request.gone'; requestId: string; reason: string }
  | { kind: 'linked'; linkId: string; peer: PeerView; topic: string; direction: 'in' | 'out'; remembered: boolean }
  | { kind: 'declined'; linkId: string; peer: PeerView; topic: string; reason: string }
  | { kind: 'message'; linkId: string; peer: PeerView; text: string; flags: string[]; seq: number }
  | { kind: 'sent'; linkId: string; seq: number; text: string; delivered: number; queued: boolean }
  | { kind: 'acked'; linkId: string; seq: number }
  | { kind: 'closed'; linkId: string; peer: PeerView; topic: string; by: 'peer' | 'me'; reason: string }
  | { kind: 'policy'; linkId: string; send: SendPolicy; allowSecrets: boolean }
  | { kind: 'paired'; contact: string; safety: string }
  | { kind: 'relay'; connected: boolean; detail?: string }
  | { kind: 'dropped'; reason: string; from?: string }
  | { kind: 'file'; linkId: string; peer: PeerView; name: string; size: number; path: string }
  | { kind: 'file.sent'; linkId: string; name: string; size: number }
  | { kind: 'note'; key: string; peer: PeerView; noteKind: NoteKind; subject: string }
  | { kind: 'note.applied'; key: string; peer: PeerView; noteKind: NoteKind; subject: string; mode: Mode }
  | { kind: 'keys.changed'; peer: PeerView }
  | { kind: 'note.sent'; key: string; peer: PeerView; noteKind: NoteKind; subject: string; auto: boolean; mode: Mode }
  | { kind: 'note.state'; key: string; peer: PeerView; state: NoteState; subject: string }

export type Notice = {
  id: number
  kind: 'message' | 'request' | 'accepted' | 'declined' | 'closed' | 'note'
  linkId: string
  text: string
  at: number
  delivered: boolean
  taint?: { by: string; linkId: string; isolation?: Isolation }
}

type LinkState = {
  id: string
  peerId: string
  peerSession: SessionInfo
  topic: string
  topicFlags: string[]
  direction: 'in' | 'out'
  group?: GroupView
  peerCaps: LinkCaps
  sendOverride?: Approval
  allowSecrets: boolean
  createdAt: number
  lastActivity: number
  seqOut: number
  seqIn: number
  acked: number
  received: number
  autoStreak: number
  inbound: number[]
  // Chain keys and how far each has been stepped (message seq).
  sendKey: Uint8Array
  recvKey: Uint8Array
  sendIndex: number
  recvIndex: number
}

type IncomingState = {
  id: string
  peerId: string
  session: SessionInfo
  topic: string
  topicFlags: string[]
  message?: string
  flags: string[]
  group?: GroupView
  peerCaps: LinkCaps
  peerEph: string
  at: number
}
type OutgoingState = { id: string; peerId: string; topic: string; message?: string; group?: GroupView; ephPriv: Uint8Array; at: number }

export class SecretError extends Error {}

type FileMeta = { fileId: string; name: string; kind: FileKind; mime: string; size: number; sha256: string; chunks: number; key: string; note?: string }
type Transfer = { linkId: string; peerId: string; meta: FileMeta; key: Uint8Array; got: Set<number>; tmp: string; fd: number; at: number; noteFlags: string[] }
export type ReceivedFile = { path: string; name: string; kind: FileKind; size: number; sha256: string; by: string; peerId: string; linkId: string; at: number }

const MAX_TRANSFERS_PER_LINK = 3
const TRANSFER_TTL_MS = 10 * 60_000

function wipe(l: LinkState) {
  l.sendKey.fill(0)
  l.recvKey.fill(0)
}

const REQUEST_TTL_MS = 30 * 60 * 1000
const SEEN_CAP = 5000
const MAX_PENDING = 20
const MAX_PENDING_PER_PEER = 3
const FULL_CAPS: LinkCaps = { send: true, receive: true }

export type NodeOptions = {
  store: Store
  session: SessionInfo
  relayUrl?: string
  identity?: Identity
  policies?: Policies
  // Hand messages a person's mode lets through to this session's agent. Only the
  // bridge, which has an agent behind it, sets this; the CLI never does.
  applies?: boolean
}

export type ConnectResult = { group?: GroupView; links: Array<{ linkId: string; peer: string; delivered: number; queued: boolean }>; redacted: number }
export type LinkSendResult = { sent: Array<{ linkId: string; peer: string; seq: number; delivered: number; queued: boolean }>; text: string; redacted: number }

export class AgentNode {
  readonly store: Store
  readonly session: SessionInfo
  readonly identity: Identity
  readonly relayUrl: string | null
  readonly policies: Policies
  pool: RelayPool | null = null
  paused = false
  mode: Role | null = null

  links = new Map<string, LinkState>()
  incoming = new Map<string, IncomingState>()
  outgoing = new Map<string, OutgoingState>()
  notices: Notice[] = []
  tainted: { by: string; linkId: string; at: number; isolation?: Isolation } | null = null
  // Someone's message entered this session's context. Until /clear (or the human
  // ends it on the band), tools are gated as if a link with them were open.
  exposure: { by: string; isolation: Isolation; at: number } | null = null

  private noticeSeq = 0
  private seen = new Set<string>()
  private listeners = new Set<(e: NodeEvent) => void>()
  private waiters = new Map<string, (p: Payload, from: string) => void>()
  private deviceWaiters = new Map<string, (p: PayloadOf<'device.request'>, from: string) => void>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private transfers = new Map<string, Transfer>()
  private lastDrop = new Map<string, number>()

  constructor(opts: NodeOptions) {
    this.store = opts.store
    this.session = opts.session
    this.identity = opts.identity ?? opts.store.requireIdentity()
    this.relayUrl = opts.relayUrl ?? opts.store.config().relay ?? null
    this.policies = opts.policies ?? new Policies(opts.store)
    this.applies = opts.applies === true
    const j = this.policies.journal()
    if (j) {
      const journal = new Journal(j, { name: this.identity.name, device: this.session.device }, this.store.home)
      this.store.tee = e => journal.write(e)
    }
  }

  private readonly applies: boolean

  get relay(): RelayClient | null {
    return this.pool?.home ?? null
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(opts: { waitForRelay?: boolean } = {}): Promise<void> {
    if (this.relayUrl) {
      const problem = this.policies.relayCheck(this.relayUrl)
      if (problem) throw new Error(problem)
      this.pool = new RelayPool(this.relayUrl, this.identity, {
        onEnvelope: env => this.handleEnvelope(env),
        onStatus: (connected, detail) => {
          this.emit({ kind: 'relay', connected, detail })
          if (connected) void this.teamSync().catch(() => {})
        },
        check: this.policies.relayCheck,
        device: this.store.deviceId(),
      })
      const ready = this.pool.start()
      if (opts.waitForRelay !== false) await ready
      else ready.catch(() => {})
    }
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      this.timers.push(t)
    }
    every(60_000, () => this.sweep())
    this.pruneNotes()
    every(3600_000, () => this.pruneNotes())
    // Answers that came in while this project had no session open.
    for (const key of Object.keys(this.store.notes())) this.applyNote(key)
    const admin = Object.values(this.store.teams()).some(t => t.adminKey)
    every(admin ? 2 * 60_000 : 10 * 60_000, () => void this.teamSync().catch(() => {}))
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    await Promise.allSettled([...this.links.keys()].map(id => this.close(id, 'ended')))
    this.pool?.close()
  }

  on(fn: (e: NodeEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: NodeEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e)
      } catch {}
    }
  }

  private sweep(now = Date.now()) {
    for (const [id, r] of this.incoming) {
      if (now - r.at > REQUEST_TTL_MS) {
        this.incoming.delete(id)
        this.emit({ kind: 'request.gone', requestId: id, reason: 'expired' })
      }
    }
    for (const [id, o] of this.outgoing) {
      if (now - o.at <= REQUEST_TTL_MS) continue
      o.ephPriv.fill(0)
      this.outgoing.delete(id)
    }
    for (const [id, t] of this.transfers) {
      if (now - t.at < TRANSFER_TTL_MS) continue
      this.dropTransfer(id, 'file transfer timed out')
    }
    const idle = (this.store.config().linkIdleMinutes ?? 60) * 60_000
    for (const [id, l] of this.links) if (idle > 0 && now - l.lastActivity > idle) void this.close(id, 'idle').catch(() => {})
  }

  // What peers learn about this session; the profile may hide the machine and folder names.
  private shared(): SessionInfo {
    const f = this.policies.features().features
    return { ...this.session, label: f.shareSession ? this.session.label : 'session', device: f.shareDevice ? this.session.device : 'private', ...(this.policies.journal() ? { kept: true } : {}) }
  }

  externalAllowed(): string | null {
    const r = this.policies.features()
    if (r.features.orgOnly) return this.policies.org ? `on the ${this.policies.org.name} plan you can only link with colleagues in your org's teams` : "your profile only allows colleagues in your org's teams"
    if (!r.features.external) return `pairing with people outside your teams is turned off (${r.from.external})`
    return null
  }

  // ---- people --------------------------------------------------------------

  private selfContact(): Contact {
    return {
      id: this.identity.card.sign,
      name: this.identity.name,
      card: this.identity.card,
      rel: 'self',
      via: 'device',
      teams: [],
      addedAt: this.identity.card.created,
      relay: this.relayUrl ?? undefined,
    }
  }

  contact(id: string): Contact | null {
    if (id === this.identity.card.sign) return this.selfContact()
    return this.store.contacts()[id] ?? null
  }

  peerView(id: string): PeerView {
    const c = this.contact(id)
    const fp = fingerprint(id)
    if (!c) return { id, name: 'unknown', rel: 'external', fingerprint: fp, label: `unknown~${fp.slice(0, 4)}` }
    const label = c.rel === 'self' ? `${c.name} (you)` : contactLabel(c, this.store.contacts(), this.store.teams())
    return { id, name: c.name, rel: c.rel, fingerprint: fp, label }
  }

  policyFor(peerId: string): Policy {
    const c = this.contact(peerId)
    const p = this.policies.forContact(c ?? { ...this.selfContact(), id: peerId, rel: 'external' })
    return c ? p : { ...p, role: 'off', caps: ROLES.off }
  }

  // Accepts a name, handle@team, team handle, fingerprint (or its start), or raw key.
  resolvePeer(ref: string): Contact | null {
    const r = ref.trim().replace(/^@/, '')
    if (!r) return null
    const lower = r.toLowerCase()
    if (['me', 'self', 'myself'].includes(lower)) return this.selfContact()
    const all = Object.values(this.store.contacts()).filter(c => !c.blocked)
    const teams = this.store.teams()
    const fpRef = r.toUpperCase().replace(/-/g, '')
    const matches = all.filter(c => {
      const label = contactLabel(c, this.store.contacts(), teams).toLowerCase()
      return (
        c.id === r ||
        label === lower ||
        c.name === lower ||
        c.handle === lower ||
        (fpRef.length >= 4 && fingerprint(c.id).replace(/-/g, '').startsWith(fpRef))
      )
    })
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} contacts, use the fingerprint shown by quietsync contacts`)
    if (lower === this.identity.name) return this.selfContact()
    return null
  }

  // ---- view ----------------------------------------------------------------

  linkView(l: LinkState): LinkView {
    const p = this.policyFor(l.peerId)
    const mayAuto = this.policies.autoSendAllowed() && !p.blockedBy && atLeast(p.maxMode, 'auto')
    const send = l.sendOverride === 'ask' || (l.sendOverride === 'auto' && mayAuto) ? l.sendOverride : p.send === 'auto' || (mayAuto && atLeast(p.mode, 'auto')) ? 'auto' : 'ask'
    return {
      id: l.id,
      peer: this.peerView(l.peerId),
      peerSession: l.peerSession,
      topic: l.topic,
      topicFlags: l.topicFlags,
      direction: l.direction,
      group: l.group,
      caps: p.caps,
      peerCaps: l.peerCaps,
      role: p.role,
      mode: p.mode,
      send,
      allowSecrets: l.allowSecrets,
      isolation: p.isolation,
      secrets: p.secrets,
      autoSendLimit: p.autoSendLimit,
      autoStreak: l.autoStreak,
      createdAt: l.createdAt,
      lastActivity: l.lastActivity,
      sent: l.seqOut,
      received: l.received,
      acked: l.acked,
    }
  }

  view(delivery: SessionView['delivery']): SessionView {
    const links = [...this.links.values()].map(l => this.linkView(l))
    const incoming: RequestView[] = [...this.incoming.values()].map(r => ({
      id: r.id,
      peer: this.peerView(r.peerId),
      session: r.session,
      topic: r.topic,
      topicFlags: r.topicFlags,
      message: r.message,
      flags: r.flags,
      group: r.group,
      peerCaps: r.peerCaps,
      at: r.at,
    }))
    const outgoing: OutgoingView[] = [...this.outgoing.values()].map(o => ({ id: o.id, peer: this.peerView(o.peerId), topic: o.topic, group: o.group, at: o.at }))
    const rank = { relaxed: 0, standard: 1, strict: 2 } as const
    const levels = [...links.map(l => l.isolation), this.tainted?.isolation, this.exposure?.isolation].filter((x): x is Isolation => !!x)
    const isolation = levels.length ? levels.reduce((a, b) => (rank[a] >= rank[b] ? a : b)) : null
    return {
      session: this.session,
      identity: { name: this.identity.name, fingerprint: fingerprint(this.identity.card.sign) },
      relay: { url: this.relayUrl, connected: this.pool?.connected ?? false },
      links,
      incoming,
      outgoing,
      tainted: this.tainted,
      exposure: this.exposure,
      isolation,
      paused: this.paused,
      kept: !!this.policies.journal(),
      mode: this.mode,
      maxLinks: this.policies.maxLinks(),
      policyChanged: this.policies.changedOnDisk,
      profile: this.profileView(),
      delivery,
      pending: this.notices.filter(n => !n.delivered).length,
    }
  }

  profileView(): ProfileView {
    const r = this.policies.features()
    return {
      name: r.profile,
      org: this.policies.org?.name ?? null,
      orgOnly: r.features.orgOnly,
      external: r.features.external,
      requireVerified: r.features.requireVerified,
      autoSend: this.policies.autoSendAllowed(),
      autoAccept: r.features.autoAccept,
      files: r.features.files,
      messages: r.features.messages,
      records: r.features.records,
    }
  }

  // Why a pasted code can't be used under the active profile, or null.
  checkCode(code: string): string | null {
    let inv
    try {
      inv = decodeInvite(code)
    } catch (e) {
      return (e as Error).message
    }
    if (inv.k === 'contact') {
      const no = this.externalAllowed()
      return no ? `can't pair with ${inv.p.name}: ${no}` : null
    }
    if (inv.k === 'team' && this.policies.features().features.orgOnly && !this.policies.joinAllowed(inv.team)) {
      return `team ${inv.team.name} isn't tied to ${this.policies.org ? `your org (${this.policies.org.name})` : 'your org'}, and you can only join your org's teams`
    }
    return null
  }

  // ---- notices (what the model gets told) ---------------------------------

  private notice(kind: Notice['kind'], linkId: string, text: string, taint?: Notice['taint']) {
    this.notices.push({ id: ++this.noticeSeq, kind, linkId, text, at: Date.now(), delivered: false, taint })
    if (this.notices.length > 200) this.notices.splice(0, this.notices.length - 200)
  }

  undelivered(): Notice[] {
    return this.notices.filter(n => !n.delivered)
  }

  // `seenByModel: false` is for notices only the human saw (requests on the band).
  // Peer messages handed to the model since the human last typed. Past the
  // limit, delivery waits for the human so two agents can't keep each other busy.
  peerWakes = 0

  wakeHeld(): boolean {
    return this.peerWakes >= this.policies.wakeLimit()
  }

  markDelivered(ids: number[], opts: { seenByModel?: boolean } = {}): void {
    for (const n of this.notices) {
      if (!ids.includes(n.id) || n.delivered) continue
      n.delivered = true
      if (!n.taint || opts.seenByModel === false) continue
      if (n.kind === 'message') this.peerWakes++
      // From here until the human takes over, the session runs at peer privilege.
      if (this.tainted?.linkId !== n.taint.linkId) this.store.audit({ event: 'turn.peer', by: n.taint.by, link: n.taint.linkId, privilege: 'peer', session: this.session.id })
      this.tainted = { ...n.taint, at: Date.now() }
      // Their words stay in the context after the link closes, so the gate outlives it.
      this.expose(n.taint.by, n.taint.isolation ?? 'standard')
    }
  }

  noteHuman(): void {
    this.peerWakes = 0
  }

  takeNotices(): Notice[] {
    const out = this.undelivered()
    this.markDelivered(out.map(n => n.id))
    return out
  }

  clearTaint(): void {
    if (this.tainted) this.store.audit({ event: 'turn.human', after: this.tainted.by, link: this.tainted.linkId, privilege: 'human', session: this.session.id })
    this.tainted = null
    for (const l of this.links.values()) l.autoStreak = 0
  }

  // ---- wire ----------------------------------------------------------------

  private requirePool(): RelayPool {
    if (!this.pool) throw new Error('no relay configured, run `quietsync setup`')
    return this.pool
  }

  private async sendTo(card: Pick<IdentityCard, 'sign' | 'box'>, payload: Payload, relay?: string | null) {
    const env = sealEnvelope(this.identity, card, payload)
    if (payload.t === 'note.msg' || payload.t === 'note.ack' || payload.t === 'id.rotate') env.keep = true
    const target = relay === undefined ? this.contact(card.sign)?.relay : relay
    return this.requirePool().get(target).send(env)
  }

  private cardFor(peerId: string): IdentityCard {
    const c = this.contact(peerId)
    if (!c) throw new Error('unknown peer')
    return c.card
  }

  handleEnvelope(env: Envelope): void {
    if (!isEnvelope(env) || this.seen.has(env.id)) return
    this.seen.add(env.id)
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.values().next().value!)
    let payload: Payload
    try {
      const parsed = Payload.safeParse(openEnvelope(this.identity, env))
      if (!parsed.success) return this.drop('malformed payload', env.from)
      payload = parsed.data
    } catch (e) {
      return this.drop(e instanceof EnvelopeError ? e.message : 'unreadable envelope', env.from)
    }
    if (payload.sid === this.session.id) return
    try {
      this.dispatch(env.from, payload, env.ts)
    } catch (e) {
      this.drop(`handler error: ${(e as Error).message}`, env.from)
    }
  }

  // Drops are audited, but a flood of them from strangers is collapsed.
  private drop(reason: string, from?: string) {
    const key = `${reason}|${from ?? ''}`
    const now = Date.now()
    if (now - (this.lastDrop.get(key) ?? 0) < 10_000) return
    this.lastDrop.set(key, now)
    if (this.lastDrop.size > 500) this.lastDrop.clear()
    this.store.audit({ dir: 'in', event: 'dropped', reason, from, session: this.session.id })
    this.emit({ kind: 'dropped', reason, from })
  }

  // A contact can tell us where to reach them, but only over wss; plain ws is
  // only taken when our own relay is a local test one.
  private learnRelay(contact: Contact, relay: string | undefined) {
    if (!relay || contact.rel === 'self' || contact.relay === relay || this.policies.relayCheck(relay)) return
    if (relay.startsWith('ws://') && !this.relayUrl?.startsWith('ws://')) return
    this.store.updateContacts(all => {
      if (all[contact.id]) all[contact.id]!.relay = relay
    })
  }

  private dispatch(from: string, p: Payload, ts: number): void {
    const waiterKey = 'inviteId' in p ? `${p.t}:${p.inviteId}` : ''
    switch (p.t) {
      case 'pair.request':
        return void this.onPairRequest(from, p)
      case 'pair.accept':
        this.waiters.get(waiterKey)?.(p, from)
        return this.onPairAccept(from, p)
      case 'pair.reject':
        this.waiters.get(waiterKey)?.(p, from)
        return
      case 'device.request':
        this.deviceWaiters.get(p.inviteId)?.(p, from)
        return
      case 'device.grant':
        this.waiters.get(waiterKey)?.(p, from)
        return
    }

    const contact = this.contact(from)
    if (!contact || contact.blocked) return this.drop('link traffic from someone who is not a contact', from)

    switch (p.t) {
      case 'link.request':
        return this.onLinkRequest(contact, p, ts)
      case 'link.accept': {
        const out = this.outgoing.get(p.linkId)
        if (!out || out.peerId !== from) {
          // A second session of theirs accepted after the first one did.
          const link = this.links.get(p.linkId)
          if (link && link.peerId === from && link.peerSession.id !== p.sid) {
            void this.sendTo(contact.card, { t: 'link.close', sid: this.session.id, linkId: p.linkId, reason: 'taken', to: p.sid }).catch(() => {})
          }
          return
        }
        this.outgoing.delete(p.linkId)
        this.learnRelay(contact, p.relay)
        const peerCaps = p.caps ?? FULL_CAPS
        let keys
        try {
          keys = linkKeys(out.ephPriv, unb64u(p.eph), { linkId: p.linkId, initiator: this.identity.card.sign, responder: from, iAmInitiator: true })
        } catch {
          return this.drop('link accept with a bad ephemeral key', from)
        } finally {
          out.ephPriv.fill(0)
        }
        const link = this.addLink(p.linkId, from, p.session, out.topic, [], 'out', peerCaps, keys, out.group)
        const peer = this.peerView(from)
        if (out.message) link.seqOut = 1
        this.notice(
          'accepted',
          p.linkId,
          frameAccepted({ peer, linkId: p.linkId, topic: out.topic, sentFirst: !!out.message, theyReply: peerCaps.send, theyRead: peerCaps.receive }),
        )
        this.store.audit({ dir: 'in', event: 'link.accepted', link: p.linkId, peer: from, session: this.session.id })
        return this.emit({ kind: 'linked', linkId: p.linkId, peer, topic: out.topic, direction: 'out', remembered: false })
      }
      case 'link.decline': {
        const out = this.outgoing.get(p.linkId)
        if (!out || out.peerId !== from) return
        this.outgoing.delete(p.linkId)
        out.ephPriv.fill(0)
        const peer = this.peerView(from)
        const reason = reasonText(p.reason)
        this.notice('declined', p.linkId, frameDeclined({ peer, topic: out.topic, reason }))
        this.store.audit({ dir: 'in', event: 'link.declined', link: p.linkId, peer: from, reason, session: this.session.id })
        return this.emit({ kind: 'declined', linkId: p.linkId, peer, topic: out.topic, reason })
      }
      case 'link.claimed': {
        if (from !== this.identity.card.sign) return
        if (this.incoming.delete(p.linkId)) this.emit({ kind: 'request.gone', requestId: p.linkId, reason: 'accepted in another session' })
        return
      }
      case 'link.msg': {
        const link = this.links.get(p.linkId)
        if (!link || link.peerId !== from || link.peerSession.id !== p.sid) return
        if (p.seq <= link.seqIn) return
        const now = Date.now()
        link.inbound = link.inbound.filter(t => now - t < 60_000)
        const perMinute = this.policies.inboundPerMinute()
        if (link.inbound.length >= perMinute) {
          this.drop('peer is sending too fast', from)
          if (link.inbound.length >= perMinute * 2) void this.close(link.id, 'flood').catch(() => {})
          link.inbound.push(now)
          return
        }
        // Step the chain on a copy, and only keep it if the message opens.
        let plain: string
        try {
          const r = ratchet(link.recvKey, link.recvIndex, p.seq)
          plain = openLinkText(r.mk, link.id, p.seq, p.box)
          r.mk.fill(0)
          link.recvKey.fill(0)
          link.recvKey = r.chain
          link.recvIndex = p.seq
        } catch {
          return this.drop('link message failed to decrypt', from)
        }
        link.inbound.push(now)
        link.seqIn = p.seq
        link.lastActivity = now
        const policy = this.policyFor(from)
        if (!policy.caps.receive) {
          this.store.audit({ dir: 'in', event: 'message.dropped', link: p.linkId, peer: from, seq: p.seq, reason: `role ${policy.role}`, session: this.session.id })
          return
        }
        link.received++
        const { text, flags } = sanitizeInbound(plain)
        const peer = this.peerView(from)
        this.store.audit({ dir: 'in', event: 'message', link: p.linkId, peer: from, seq: p.seq, flags, text, session: this.session.id })
        this.notice(
          'message',
          p.linkId,
          frameMessage({
            peer,
            linkId: p.linkId,
            topic: link.topic,
            topicFlags: link.topicFlags,
            text,
            flags,
            canReply: policy.caps.send && link.peerCaps.receive,
            group: link.group?.id,
          }),
          { by: peer.label, linkId: p.linkId, isolation: policy.isolation },
        )
        this.emit({ kind: 'message', linkId: p.linkId, peer, text, flags, seq: p.seq })
        if (this.policies.features().features.receipts) void this.sendTo(contact.card, { t: 'link.ack', sid: this.session.id, linkId: p.linkId, seq: p.seq }).catch(() => {})
        return
      }
      case 'link.file':
        return this.onFileOffer(contact, p)
      case 'link.chunk':
        return this.onChunk(contact, p)
      case 'link.ack': {
        const link = this.links.get(p.linkId)
        if (!link || link.peerId !== from || link.peerSession.id !== p.sid) return
        link.acked = Math.max(link.acked, p.seq)
        return this.emit({ kind: 'acked', linkId: p.linkId, seq: p.seq })
      }
      case 'note.msg':
        return this.onNote(contact, p, ts)
      case 'note.ack':
        return this.onNoteAck(contact, p)
      case 'id.rotate':
        return this.onRotate(contact, p)
      case 'link.close': {
        if (p.to && p.to !== this.session.id) return
        const link = this.links.get(p.linkId)
        if (!link || link.peerId !== from || link.peerSession.id !== p.sid) {
          if (this.incoming.get(p.linkId)?.peerId === from) {
            this.incoming.delete(p.linkId)
            this.emit({ kind: 'request.gone', requestId: p.linkId, reason: 'withdrawn' })
          }
          return
        }
        this.links.delete(p.linkId)
        wipe(link)
        const peer = this.peerView(from)
        const reason = reasonText(p.reason)
        this.notice('closed', p.linkId, frameClosed({ peer, linkId: p.linkId, topic: this.topicFor(link), reason }))
        this.store.audit({ dir: 'in', event: 'link.closed', link: p.linkId, peer: from, reason, session: this.session.id })
        return this.emit({ kind: 'closed', linkId: p.linkId, peer, topic: link.topic, by: 'peer', reason })
      }
    }
  }

  private topicFor(l: { topic: string; topicFlags: string[] }): string {
    return isSuspicious(l.topicFlags) ? '(withheld topic)' : l.topic
  }

  private addLink(
    id: string,
    peerId: string,
    peerSession: SessionInfo,
    topic: string,
    topicFlags: string[],
    direction: 'in' | 'out',
    peerCaps: LinkCaps,
    keys: { send: Uint8Array; recv: Uint8Array },
    group?: GroupView,
  ): LinkState {
    const now = Date.now()
    const link: LinkState = {
      id,
      peerId,
      peerSession: { ...peerSession, label: sanitizeLabel(peerSession.label, 80), device: sanitizeLabel(peerSession.device, 64) },
      topic,
      topicFlags,
      direction,
      group,
      peerCaps,
      allowSecrets: false,
      createdAt: now,
      lastActivity: now,
      seqOut: 0,
      seqIn: 0,
      acked: 0,
      received: 0,
      autoStreak: 0,
      inbound: [],
      sendKey: keys.send,
      recvKey: keys.recv,
      sendIndex: 0,
      recvIndex: 0,
    }
    this.links.set(id, link)
    return link
  }

  private onLinkRequest(contact: Contact, p: PayloadOf<'link.request'>, ts: number) {
    if (this.links.has(p.linkId) || this.incoming.has(p.linkId)) return
    if (Date.now() - ts > REQUEST_TTL_MS) return this.drop('stale link request', contact.id)
    if (p.toSession && p.toSession.toLowerCase() !== this.session.label.toLowerCase()) return
    this.learnRelay(contact, p.relay)
    const policy = this.policyFor(contact.id)
    const sanitized = sanitizeInbound(p.topic)
    const topic = sanitized.text.replace(/\s+/g, ' ').slice(0, 200)
    this.store.audit({ dir: 'in', event: 'link.request', link: p.linkId, peer: contact.id, topic, session: this.session.id })
    if (!policy.caps.accept) {
      this.store.audit({ dir: 'out', event: 'link.decline', link: p.linkId, peer: contact.id, reason: policy.blockedBy ?? `role ${policy.role}`, session: this.session.id })
      void this.sendTo(contact.card, { t: 'link.decline', sid: this.session.id, linkId: p.linkId, reason: 'not-accepting' }).catch(() => {})
      return
    }
    const fromPeer = [...this.incoming.values()].filter(r => r.peerId === contact.id).length
    if (this.paused || fromPeer >= MAX_PENDING_PER_PEER || this.incoming.size >= MAX_PENDING || this.links.size >= this.policies.maxLinks()) {
      return this.drop(this.paused ? 'request while paused' : 'too many pending requests', contact.id)
    }
    const first = p.message ? sanitizeInbound(p.message) : null
    const req: IncomingState = {
      id: p.linkId,
      peerId: contact.id,
      session: { ...p.session, label: sanitizeLabel(p.session.label, 80), device: sanitizeLabel(p.session.device, 64) },
      topic,
      topicFlags: sanitized.flags,
      message: first?.text,
      flags: first?.flags ?? [],
      group: p.group,
      peerCaps: p.caps ?? FULL_CAPS,
      peerEph: p.eph,
      at: Date.now(),
    }
    this.incoming.set(p.linkId, req)
    if (policy.links === 'auto' || policy.mode === 'trusted') {
      void this.accept(p.linkId, { remembered: true }).catch(() => {})
      return
    }
    const peer = this.peerView(contact.id)
    this.notice(
      'request',
      p.linkId,
      frameRequest({ peer, requestId: p.linkId, topic, topicFlags: req.topicFlags, hasMessage: !!req.message, group: p.group?.size }),
      { by: peer.label, linkId: p.linkId },
    )
    this.emit({ kind: 'request', requestId: p.linkId, peer, topic, message: req.message, flags: [...req.topicFlags, ...req.flags] })
  }

  // ---- outbound checks -----------------------------------------------------

  // The exact text that would leave for these targets, after cleaning, the
  // secret scan and redaction. The approval dialog and the send both use it.
  prepare(targets: Array<{ linkId?: string; peerId?: string }>, text: string): Outbound {
    const policies = targets.map(t => this.policyFor(t.linkId ? (this.links.get(t.linkId)?.peerId ?? '') : (t.peerId ?? '')))
    const links = targets.map(t => (t.linkId ? this.links.get(t.linkId) : undefined))
    return prepareOutbound(text, {
      mode: policies.some(p => p.secrets === 'block') ? 'block' : 'redact',
      allowSecrets: links.length > 0 && links.every(l => l?.allowSecrets === true),
      maxChars: Math.min(...policies.map(p => p.maxMessageChars)),
      dlp: this.policies.dlp(),
    })
  }

  // ---- link actions --------------------------------------------------------

  async connect(peerRefs: string | string[], topic: string, message?: string, opts: { session?: string } = {}): Promise<ConnectResult> {
    const refs = [...new Set((Array.isArray(peerRefs) ? peerRefs : [peerRefs]).map(r => r.trim()).filter(Boolean))]
    if (!refs.length) throw new Error('name at least one peer')
    if (refs.length > MAX_GROUP) throw new Error(`a group link can have at most ${MAX_GROUP} people`)
    const contacts = refs.map(r => {
      const c = this.resolvePeer(r)
      if (!c) throw new Error(`no contact called "${r}". Pair first with \`quietsync invite\` / \`quietsync pair\`, or join a team.`)
      return c
    })
    for (const c of contacts) {
      const p = this.policyFor(c.id)
      if (p.blockedBy) throw new Error(p.blockedBy)
      if (!p.caps.initiate) throw new Error(`your policy for ${this.peerView(c.id).label} is "${p.role}" (${ROLE_HELP[p.role]})`)
    }
    if (this.links.size + this.outgoing.size + contacts.length > this.policies.maxLinks()) throw new Error(`too many links in this session (limit ${this.policies.maxLinks()})`)
    const targets = contacts.map(c => ({ peerId: c.id }))
    const t = cleanOutbound(topic).text.replace(/\s+/g, ' ')
    if (!t) throw new Error('topic is required')
    if (t.length > 200) throw new Error('topic is too long')
    const tf = scanSecrets(t, this.policies.dlp()).filter(f => f.severity === 'block')
    if (tf.length) throw new SecretError(`blocked: the topic looks like it contains secrets (${describeFindings(tf)})`)
    let first: Outbound | null = null
    if (message?.trim()) {
      first = this.prepare(targets, message)
      if (first.blocked) throw new SecretError(`blocked: ${first.blocked}`)
    }
    const group = contacts.length > 1 ? { id: `g${randomId(8)}`, size: contacts.length } : undefined
    const results: ConnectResult['links'] = []
    for (const c of contacts) {
      const policy = this.policyFor(c.id)
      const linkId = randomId(9)
      const eph = newBoxKey()
      this.outgoing.set(linkId, { id: linkId, peerId: c.id, topic: t, message: first?.text, group, ephPriv: eph.priv, at: Date.now() })
      const res = await this.sendTo(c.card, {
        t: 'link.request',
        sid: this.session.id,
        linkId,
        session: this.shared(),
        topic: t,
        message: first?.text,
        caps: { send: policy.caps.send, receive: policy.caps.receive },
        group,
        relay: this.relayUrl ?? undefined,
        toSession: opts.session || undefined,
        eph: b64u(eph.pub),
      })
      this.store.audit({ dir: 'out', event: 'link.request', link: linkId, peer: c.id, topic: t, text: first?.text, group: group?.id, session: this.session.id })
      results.push({ linkId, peer: this.peerView(c.id).label, ...res })
    }
    return { group, links: results, redacted: first?.redacted ?? 0 }
  }

  async accept(requestId: string, opts: { remember?: boolean; remembered?: boolean } = {}): Promise<LinkView> {
    const req = this.incoming.get(requestId)
    if (!req) throw new Error(`no pending link request ${requestId}`)
    const contact = this.contact(req.peerId)
    if (!contact) throw new Error('requester is no longer a contact')
    const policy = this.policyFor(req.peerId)
    if (policy.blockedBy) throw new Error(policy.blockedBy)
    if (!policy.caps.accept) throw new Error(`your policy for ${contact.name} doesn't accept links`)
    if (this.links.size >= this.policies.maxLinks()) throw new Error(`this session is at its link limit (${this.policies.maxLinks()})`)
    this.incoming.delete(requestId)
    if (!this.store.claimLink(req.id, this.session.id)) {
      this.emit({ kind: 'request.gone', requestId, reason: 'accepted in another session' })
      throw new Error('another session on this machine already took this request')
    }
    if (opts.remember && contact.rel !== 'self') {
      this.policies.humanUpdate(f => {
        f.contacts ??= {}
        f.contacts[contact.id] = { ...f.contacts[contact.id], links: 'auto' }
      })
    }
    const eph = newBoxKey()
    const keys = linkKeys(eph.priv, unb64u(req.peerEph), { linkId: req.id, initiator: req.peerId, responder: this.identity.card.sign, iAmInitiator: false })
    eph.priv.fill(0)
    const link = this.addLink(req.id, req.peerId, req.session, req.topic, req.topicFlags, 'in', req.peerCaps, keys, req.group)
    await this.sendTo(contact.card, {
      t: 'link.accept',
      sid: this.session.id,
      linkId: req.id,
      session: this.shared(),
      caps: { send: policy.caps.send, receive: policy.caps.receive },
      relay: this.relayUrl ?? undefined,
      eph: b64u(eph.pub),
    })
    void this.sendTo(this.identity.card, { t: 'link.claimed', sid: this.session.id, linkId: req.id }, this.relayUrl).catch(() => {})
    const peer = this.peerView(req.peerId)
    this.store.audit({ dir: 'out', event: 'link.accept', link: req.id, peer: req.peerId, remembered: !!opts.remembered, session: this.session.id })
    this.emit({ kind: 'linked', linkId: req.id, peer, topic: req.topic, direction: 'in', remembered: !!opts.remembered })
    if (req.message && policy.caps.receive) {
      link.seqIn = 1
      link.received = 1
      this.store.audit({ dir: 'in', event: 'message', link: req.id, peer: req.peerId, seq: 1, flags: req.flags, text: req.message, session: this.session.id })
      this.notice(
        'message',
        req.id,
        frameMessage({
          peer,
          linkId: req.id,
          topic: req.topic,
          topicFlags: req.topicFlags,
          text: req.message,
          flags: req.flags,
          canReply: policy.caps.send && req.peerCaps.receive,
          group: req.group?.id,
        }),
        { by: peer.label, linkId: req.id, isolation: policy.isolation },
      )
      this.emit({ kind: 'message', linkId: req.id, peer, text: req.message, flags: req.flags, seq: 1 })
    }
    return this.linkView(link)
  }

  async decline(requestId: string, reason: Reason = 'declined'): Promise<void> {
    const req = this.incoming.get(requestId)
    if (!req) throw new Error(`no pending link request ${requestId}`)
    this.incoming.delete(requestId)
    await this.sendTo(this.cardFor(req.peerId), { t: 'link.decline', sid: this.session.id, linkId: requestId, reason })
    this.store.audit({ dir: 'out', event: 'link.decline', link: requestId, peer: req.peerId, reason, session: this.session.id })
    this.emit({ kind: 'request.gone', requestId, reason: 'declined' })
  }

  targets(id: string): LinkState[] {
    const l = this.links.get(id)
    return l ? [l] : [...this.links.values()].filter(x => x.group?.id === id)
  }

  async send(id: string, text: string, opts: { auto?: boolean } = {}): Promise<LinkSendResult> {
    const targets = this.targets(id)
    if (!targets.length) throw new Error(`no active link or group ${id}`)
    for (const l of targets) {
      const v = this.linkView(l)
      if (!v.caps.send) throw new Error(`your policy for ${v.peer.label} is "${v.role}", so your agent doesn't send to them`)
      if (!l.peerCaps.receive) throw new Error(`${v.peer.label}'s side doesn't take messages on this link`)
    }
    const o = this.prepare(targets.map(l => ({ linkId: l.id })), text)
    if (o.blocked) throw new SecretError(`blocked: ${o.blocked}`)
    const sent: LinkSendResult['sent'] = []
    for (const link of targets) {
      const seq = link.seqOut + 1
      const r = ratchet(link.sendKey, link.sendIndex, seq)
      const box = boxLinkText(r.mk, link.id, seq, o.text)
      r.mk.fill(0)
      link.sendKey.fill(0)
      link.sendKey = r.chain
      link.sendIndex = seq
      const res = await this.sendTo(this.cardFor(link.peerId), { t: 'link.msg', sid: this.session.id, linkId: link.id, seq, box })
      link.seqOut = seq
      link.lastActivity = Date.now()
      link.autoStreak = opts.auto ? link.autoStreak + 1 : 0
      this.store.audit({ dir: 'out', event: 'message', link: link.id, peer: link.peerId, seq, text: o.text, redacted: o.redacted || undefined, auto: opts.auto || undefined, session: this.session.id })
      this.emit({ kind: 'sent', linkId: link.id, seq, text: o.text, ...res })
      sent.push({ linkId: link.id, peer: this.peerView(link.peerId).label, seq, ...res })
    }
    return { sent, text: o.text, redacted: o.redacted }
  }

  // ---- messages that wait for people who aren't online ----------------------

  private noteInbound = new Map<string, number[]>()

  messagesAllowed(): string | null {
    const r = this.policies.features()
    return r.features.messages ? null : `messages are turned off (${r.from.messages})`
  }

  private pruneNotes() {
    try {
      const days = this.policies.features().features.auditDays
      this.store.updateNotes(all => prune(all, Math.max(30, days)))
    } catch {}
  }

  noteView(n: Note, all: Record<string, Note> = this.store.notes()): NoteView {
    const { peerId, answer, ...rest } = n
    const a = answer ? all[answer] : undefined
    return { ...rest, peer: this.peerView(peerId), answer: a ? { text: a.text, flags: a.flags, at: a.at, key: a.key, fits: fitsBand(a.text) } : undefined }
  }

  notesView(filter?: (n: Note) => boolean): NoteView[] {
    let all = this.store.notes()
    if (expire(structuredClone(all))) all = this.store.updateNotes(n => void expire(n))
    return Object.values(all)
      .filter(n => !filter || filter(n))
      .sort((a, b) => b.at - a.at)
      .map(n => this.noteView(n, all))
  }

  // By key, or by the short id people and agents see.
  findNote(ref: string, dir?: 'in' | 'out'): Note | null {
    const r = ref.trim()
    const all = this.store.notes()
    if (all[r] && (!dir || all[r]!.dir === dir)) return all[r]!
    const hits = Object.values(all).filter(n => n.id === r && (!dir || n.dir === dir))
    if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} messages, use the full key from quietsync_messages`)
    return hits[0] ?? null
  }

  private noteTarget(ref: string): Contact {
    const c = this.resolvePeer(ref)
    if (!c) throw new Error(`no contact called "${ref}". Pair first with \`quietsync invite\` / \`quietsync pair\`, or join a team.`)
    if (c.rel === 'self') throw new Error('messages are for other people. To reach your own other sessions, open a link with peer "me".')
    const p = this.policyFor(c.id)
    if (p.blockedBy) throw new Error(p.blockedBy)
    if (!p.caps.send) throw new Error(`your policy for ${this.peerView(c.id).label} is "${p.role}" (${ROLE_HELP[p.role]}), so your agent doesn't send to them`)
    return c
  }

  async sendNote(to: string, opts: { kind: 'ask' | 'note' | 'request'; subject: string; text: string; ticket?: string; auto?: boolean }): Promise<{ note: NoteView; queued: boolean; redacted: number }> {
    const off = this.messagesAllowed()
    if (off) throw new Error(off)
    const c = this.noteTarget(to)
    const subject = cleanOutbound(opts.subject).text.replace(/\s+/g, ' ').trim()
    if (!subject) throw new Error('subject is required')
    if (subject.length > 200) throw new Error('subject is too long, put details in the message')
    const sf = scanSecrets(subject, this.policies.dlp()).filter(f => f.severity === 'block')
    if (sf.length) throw new SecretError(`blocked: the subject looks like it contains secrets (${describeFindings(sf)})`)
    const ticket = opts.ticket?.trim().toUpperCase() || undefined
    if (ticket && !TICKET_RE.test(ticket)) throw new Error('ticket should look like PAY-123')
    const o = this.prepare([{ peerId: c.id }], opts.text)
    if (o.blocked) throw new SecretError(`blocked: ${o.blocked}`)
    const id = randomId(9)
    const now = Date.now()
    const res = await this.sendTo(c.card, { t: 'note.msg', sid: this.session.id, noteId: id, kind: opts.kind, subject, text: o.text, ticket, session: this.shared(), relay: this.relayUrl ?? undefined })
    const note: Note = {
      key: noteKey('out', c.id, id),
      id,
      dir: 'out',
      peerId: c.id,
      kind: opts.kind,
      subject,
      text: o.text,
      flags: [],
      ticket,
      ticketBy: ticket ? 'me' : undefined,
      at: now,
      state: res.delivered > 0 ? 'sent' : 'queued',
      stateAt: now,
      session: { id: this.session.id, label: this.session.label },
      ...(opts.auto ? { auto: true } : {}),
    }
    const all = this.store.updateNotes(n => {
      n[note.key] = note
    })
    this.store.audit({ dir: 'out', event: 'note', note: id, kind: opts.kind, peer: c.id, topic: subject, text: o.text, ticket, redacted: o.redacted || undefined, queued: !res.delivered || undefined, auto: opts.auto || undefined, session: this.session.id })
    this.emit({ kind: 'note.sent', key: note.key, peer: this.peerView(c.id), noteKind: opts.kind, subject, auto: !!opts.auto, mode: this.policyFor(c.id).mode })
    return { note: this.noteView(note, all), queued: res.delivered === 0, redacted: o.redacted }
  }

  async replyNote(ref: string, text: string, opts: { auto?: boolean } = {}): Promise<{ note: NoteView; queued: boolean; redacted: number }> {
    const off = this.messagesAllowed()
    if (off) throw new Error(off)
    const ask = this.findNote(ref, 'in')
    if (!ask || !answerable(ask.kind)) throw new Error(`no question "${ref}" in your messages`)
    if (ask.answer && !stalePending(ask.answer)) throw new Error('you already answered this one')
    if (ask.state === 'dismissed') throw new Error('you dismissed this one')
    const c = this.contact(ask.peerId)
    if (!c || c.blocked) throw new Error('the person who asked is no longer a contact')
    const p = this.policyFor(c.id)
    if (p.blockedBy) throw new Error(p.blockedBy)
    if (!p.caps.send) throw new Error(`your policy for ${this.peerView(c.id).label} is "${p.role}", so your agent doesn't send to them`)
    const o = this.prepare([{ peerId: c.id }], text)
    if (o.blocked) throw new SecretError(`blocked: ${o.blocked}`)
    const id = randomId(9)
    const now = Date.now()
    // Claim the question first, so two sessions can't both answer it.
    const pending = `pending:${id}:${now}`
    let claimed = false
    this.store.updateNotes(n => {
      const a = n[ask.key]
      if (!a || (a.answer && !stalePending(a.answer, now)) || a.state === 'dismissed') return
      a.answer = pending
      claimed = true
    })
    if (!claimed) throw new Error('this question was just answered or dismissed')
    let res
    try {
      res = await this.sendTo(c.card, { t: 'note.msg', sid: this.session.id, noteId: id, kind: 'reply', subject: ask.subject, text: o.text, replyTo: ask.id, ticket: ask.ticket, session: this.shared(), relay: this.relayUrl ?? undefined })
    } catch (e) {
      this.store.updateNotes(n => {
        if (n[ask.key]?.answer === pending) delete n[ask.key]!.answer
      })
      throw e
    }
    const reply: Note = {
      key: noteKey('out', c.id, id),
      id,
      dir: 'out',
      peerId: c.id,
      kind: 'reply',
      subject: ask.subject,
      text: o.text,
      flags: [],
      replyTo: ask.id,
      ticket: ask.ticket,
      ticketBy: ask.ticket ? 'them' : undefined,
      at: now,
      state: res.delivered > 0 ? 'sent' : 'queued',
      stateAt: now,
      session: { id: this.session.id, label: this.session.label },
      ...(opts.auto ? { auto: true } : {}),
    }
    const all = this.store.updateNotes(n => {
      n[reply.key] = reply
      const a = n[ask.key]
      if (a) {
        advance(a, 'answered', now)
        a.answer = reply.key
      }
    })
    this.store.audit({ dir: 'out', event: 'note', note: id, kind: 'reply', replyTo: ask.id, peer: c.id, text: o.text, redacted: o.redacted || undefined, auto: opts.auto || undefined, session: this.session.id })
    this.emit({ kind: 'note.sent', key: reply.key, peer: this.peerView(c.id), noteKind: 'reply', subject: ask.subject, auto: !!opts.auto, mode: p.mode })
    return { note: this.noteView(reply, all), queued: res.delivered === 0, redacted: o.redacted }
  }

  // A lost or retired device: new keys for this identity, announced to every
  // contact under the old ones. Anything still holding the old keys stops
  // getting new messages; your other devices join again with `device add`.
  async rotateKeys(opts: { keychain?: boolean } = {}): Promise<{ told: string[]; failed: string[]; card: IdentityCard }> {
    const next = createIdentity(this.identity.name)
    const told: string[] = []
    const failed: string[] = []
    for (const c of Object.values(this.store.contacts())) {
      if (c.blocked || c.rel === 'self') continue
      try {
        await this.sendTo(c.card, { t: 'id.rotate', sid: this.session.id, card: next.card })
        told.push(c.name)
      } catch {
        failed.push(c.name)
      }
    }
    this.store.saveIdentity(next, opts)
    this.store.addRotation(this.identity.card.sign, next.card.sign)
    this.store.audit({ event: 'keys.rotated', old: this.identity.card.sign, new: next.card.sign, told: told.length, session: this.session.id })
    return { told, failed, card: next.card }
  }

  // Their keys changed: move everything to the new ones, but trust starts over,
  // since whoever holds a stolen device could announce keys too.
  private onRotate(contact: Contact, p: PayloadOf<'id.rotate'>) {
    const card = p.card
    if (!verifyCard(card) || card.name !== contact.card.name || card.sign === contact.id) return this.drop('bad key change', contact.id)
    if (this.contact(card.sign)) return
    const oldId = contact.id
    const newId = card.sign
    this.store.addRotation(oldId, newId)
    this.store.updateContacts(all => {
      const c = all[oldId]
      if (!c) return
      delete all[oldId]
      all[newId] = { ...c, id: newId, card, verified: false }
    })
    this.store.updatePolicyFile(f => {
      const mine = f.contacts?.[oldId]
      f.contacts = { ...(f.contacts ?? {}) }
      delete f.contacts[oldId]
      f.contacts[newId] = { ...mine, mode: 'ask' }
    })
    this.store.updateNotes(all => {
      for (const n of Object.values(all)) if (n.peerId === oldId) n.peerId = newId
    })
    for (const l of [...this.links.values()]) {
      if (l.peerId !== oldId) continue
      this.links.delete(l.id)
      wipe(l)
    }
    const peer = this.peerView(newId)
    this.store.audit({ dir: 'in', event: 'keys.changed', peer: newId, old: oldId, session: this.session.id })
    this.notice('closed', `keys:${newId}`, `quietsync: ${peer.label}'s keys changed (a lost device or a rotation). Their links were closed and their mode is back to ask until your human compares safety numbers with \`quietsync verify ${peer.label}\`.`)
    this.emit({ kind: 'keys.changed', peer })
  }

  // Messages to this person that went without a dialog in the last hour.
  autoSentCount(peerId: string, now = Date.now()): number {
    return Object.values(this.store.notes()).filter(n => n.dir === 'out' && n.peerId === peerId && n.auto && now - n.at < 3600_000).length
  }

  // A message this person's mode lets through goes to the agent on its own, once,
  // in one session: an answer in the project that asked, anything else in
  // whichever session claims it first.
  applyNote(key: string): boolean {
    if (!this.applies || this.paused) return false
    const all = this.store.notes()
    const n = all[key]
    if (!n || n.dir !== 'in' || n.state !== 'new' || n.applied) return false
    const c = this.contact(n.peerId)
    if (!c || c.blocked) return false
    const policy = this.policyFor(n.peerId)
    if (policy.blockedBy || policy.flow.in[kindOf(n.kind)] !== 'auto') return false
    const ask = n.kind === 'reply' ? Object.values(all).find(a => a.dir === 'out' && answerable(a.kind) && a.answer === key) : undefined
    if (n.kind === 'reply' && (!ask || ask.continued || ask.session.label !== this.session.label)) return false
    let won = false
    this.store.updateNotes(cur => {
      const x = cur[key]
      if (!x || x.applied || x.state !== 'new') return
      x.applied = this.session.id
      if (ask && cur[ask.key]) cur[ask.key]!.continued = true
      won = true
    })
    if (!won) return false
    const peer = this.peerView(n.peerId)
    const auto = { mode: policy.mode }
    const text =
      n.kind === 'reply' && ask
        ? frameAnswer({ peer, id: ask.id, subject: ask.subject, question: ask.text, text: n.text, flags: n.flags, auto })
        : frameNote({ peer, id: n.id, kind: n.kind === 'reply' ? 'note' : n.kind, subject: n.subject, subjectFlags: n.flags, text: n.text, flags: n.flags, ticket: n.ticket, canReply: policy.caps.send, auto })
    this.store.audit({ event: 'note.applied', note: n.id, kind: n.kind, peer: n.peerId, mode: policy.mode, privilege: 'peer', session: this.session.id })
    this.notice('note', key, text, { by: peer.label, linkId: key, isolation: policy.isolation })
    this.emit({ kind: 'note.applied', key, peer, noteKind: n.kind, subject: n.subject, mode: policy.mode })
    return true
  }

  private ack(n: Pick<Note, 'peerId' | 'id'>, state: 'delivered' | 'seen' | 'declined') {
    const c = this.contact(n.peerId)
    if (!c || c.blocked) return
    void this.sendTo(c.card, { t: 'note.ack', sid: this.session.id, noteId: n.id, state }).catch(() => {})
  }

  // Seen and declined are read receipts; profiles that turn receipts off don't send them.
  markNotesSeen(keys: string[]): void {
    const moved: Note[] = []
    this.store.updateNotes(all => {
      for (const k of keys) {
        const n = all[k]
        if (n?.dir === 'in' && advance(n, 'seen')) moved.push(n)
      }
    })
    if (!this.policies.features().features.receipts) return
    for (const n of moved) if (n.kind !== 'reply') this.ack(n, 'seen')
  }

  async dismissNote(ref: string): Promise<boolean> {
    const n = this.findNote(ref, 'in')
    if (!n) throw new Error(`no message "${ref}" in your messages`)
    let moved = false
    this.store.updateNotes(all => {
      const x = all[n.key]
      if (x && (!x.answer || stalePending(x.answer))) {
        moved = advance(x, 'dismissed')
        if (moved) delete x.answer
      }
    })
    if (!moved) return false
    this.store.audit({ event: 'note.dismissed', note: n.id, peer: n.peerId, session: this.session.id })
    if (answerable(n.kind) && this.policies.features().features.receipts) this.ack(n, 'declined')
    return true
  }

  restoreExposure(e: { by: string; isolation: Isolation; at: number }): void {
    this.exposure = e
  }

  // Someone else's words entering this session: the turn runs at peer privilege.
  private taintFrom(by: string, key: string, reason: string, isolation: Isolation) {
    if (this.tainted?.linkId !== key) this.store.audit({ event: 'turn.peer', by, link: key, privilege: 'peer', reason, session: this.session.id })
    this.tainted = { by, linkId: key, at: Date.now(), isolation }
    this.expose(by, isolation)
  }

  private expose(by: string, isolation: Isolation) {
    const rank = { relaxed: 0, standard: 1, strict: 2 } as const
    if (this.exposure && rank[this.exposure.isolation] >= rank[isolation]) return
    this.exposure = { by, isolation, at: Date.now() }
  }

  clearExposure(): void {
    if (this.exposure) this.store.audit({ event: 'exposure.end', by: this.exposure.by, session: this.session.id })
    this.exposure = null
  }

  // Listing subjects other people wrote counts as reading their text.
  noteListTaint(views: NoteView[]): void {
    const theirs = views.filter(v => v.dir === 'in' || v.answer)
    if (!theirs.length) return
    const rank = { relaxed: 0, standard: 1, strict: 2 } as const
    const iso = theirs.map(v => this.policyFor(v.peer.id).isolation).reduce((a, b) => (rank[a] >= rank[b] ? a : b))
    this.taintFrom(theirs.length === 1 ? theirs[0]!.peer.label : 'several people', 'messages', 'listed messages', iso)
  }

  // The human asked their agent to look at a message: hand it over as peer text.
  openNote(ref: string, opts: { notice?: boolean } = {}): string {
    const n = this.findNote(ref)
    if (!n) throw new Error(`no message "${ref}"`)
    const all = this.store.notes()
    const peer = this.peerView(n.peerId)
    let text: string
    if (n.dir === 'out') {
      const a = n.answer ? all[n.answer] : undefined
      text = `quietsync: you sent ${peer.label} ${n.kind === 'ask' ? 'a question' : n.kind === 'request' ? 'a request' : n.kind === 'reply' ? 'an answer' : 'a message'} (message ${n.id}, "${n.subject}"), ${n.state}.\nYour text:\n${n.text}`
      if (!a) return text
      text = frameAnswer({ peer, id: n.id, subject: n.subject, question: n.text, text: a.text, flags: a.flags })
      this.markNotesSeen([a.key])
    } else {
      const c = this.contact(n.peerId)
      const p = this.policyFor(n.peerId)
      const kind = n.kind === 'reply' ? 'note' : n.kind
      text = frameNote({ peer, id: n.id, kind, subject: n.subject, subjectFlags: n.flags, text: n.text, flags: n.flags, ticket: n.ticket, canReply: !!c && !c.blocked && p.caps.send && !n.answer })
      this.markNotesSeen([n.key])
    }
    const isolation = this.policyFor(n.peerId).isolation
    if (opts.notice) this.notice('note', n.key, text, { by: peer.label, linkId: n.key, isolation })
    else this.taintFrom(peer.label, n.key, 'read a message', isolation)
    return text
  }

  // The asking session picks an answer up. The human's click vouches for it only
  // if the whole answer was on the band and it passed the injection checks;
  // otherwise it runs at peer privilege like any other peer text.
  takeAnswer(ref: string): { text: string; restricted: boolean; why?: 'flagged' | 'long' } {
    const ask = this.findNote(ref, 'out')
    if (!ask || !answerable(ask.kind) || !ask.answer) throw new Error(`no answered question "${ref}"`)
    const all = this.store.notes()
    const ans = all[ask.answer]
    if (!ans) throw new Error('the answer is no longer stored')
    const peer = this.peerView(ask.peerId)
    const text = frameAnswer({ peer, id: ask.id, subject: ask.subject, question: ask.text, text: ans.text, flags: ans.flags })
    this.store.updateNotes(n => {
      if (n[ask.key]) n[ask.key]!.continued = true
      if (n[ans.key]) advance(n[ans.key]!, 'seen')
    })
    const why = isSuspicious(ans.flags) ? 'flagged' : fitsBand(ans.text) ? undefined : 'long'
    const isolation = this.policyFor(ask.peerId).isolation
    this.store.audit({ event: 'note.continue', note: ask.id, peer: ask.peerId, privilege: why ? 'peer' : 'human', why, flags: ans.flags.length ? ans.flags : undefined, session: this.session.id })
    this.expose(peer.label, isolation)
    if (why) this.notice('note', ans.key, text, { by: peer.label, linkId: ans.key, isolation })
    return { text, restricted: !!why, why }
  }

  // The question and its answer, for records.
  thread(ref: string): { key: string; thread: Thread } {
    const n = this.findNote(ref)
    if (!n) throw new Error(`no message "${ref}"`)
    const all = this.store.notes()
    const askDir = n.dir === 'in' ? 'out' : 'in'
    const q = n.kind === 'reply' ? (Object.values(all).find(x => x.dir === askDir && x.id === n.replyTo && x.peerId === n.peerId) ?? n) : n
    const a = q.answer ? all[q.answer] : undefined
    const them = this.peerView(q.peerId).label
    const by = (x: Note) => (x.dir === 'out' ? this.identity.name : them)
    return { key: q.key, thread: { subject: q.subject, ticket: q.ticket, ticketBy: q.ticketBy ?? (q.dir === 'out' ? 'me' : 'them'), ask: { by: by(q), text: q.text, at: q.at }, answer: a ? { by: by(a), text: a.text, at: a.at } : undefined } }
  }

  // One process posts each automatic record, even with several sessions open.
  claimRecord(key: string, dest: string): boolean {
    let won = false
    this.store.updateNotes(all => {
      const n = all[key]
      if (!n || n.recorded?.includes(dest)) return
      n.recorded = [...(n.recorded ?? []), dest]
      won = true
    })
    return won
  }

  unclaimRecord(key: string, dest: string): void {
    this.store.updateNotes(all => {
      const n = all[key]
      if (n?.recorded) n.recorded = n.recorded.filter(d => d !== dest)
    })
  }

  markRecorded(key: string, dest: string): void {
    this.store.updateNotes(all => {
      const n = all[key]
      if (n && !n.recorded?.includes(dest)) n.recorded = [...(n.recorded ?? []), dest]
    })
    this.store.audit({ event: 'note.recorded', note: key, to: dest, session: this.session.id })
  }

  private onNote(contact: Contact, p: PayloadOf<'note.msg'>, ts: number) {
    const now = Date.now()
    if (now - ts > QUEUE_TTL_MS + 24 * 3600_000) return this.drop('stale message', contact.id)
    this.learnRelay(contact, p.relay)
    const policy = this.policyFor(contact.id)
    const off = this.messagesAllowed() ?? policy.blockedBy ?? (policy.caps.receive ? null : `role ${policy.role}`) ?? (policy.flow.in[kindOf(p.kind)] === 'deny' ? 'your rules' : null)
    if (off) {
      this.store.audit({ dir: 'in', event: 'note.dropped', note: p.noteId, peer: contact.id, reason: off, session: this.session.id })
      return
    }
    const recent = (this.noteInbound.get(contact.id) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= this.policies.inboundPerMinute()) return this.drop('peer is sending too fast', contact.id)
    recent.push(now)
    this.noteInbound.set(contact.id, recent)
    const subj = sanitizeInbound(p.subject)
    const body = sanitizeInbound(p.text)
    const subject = subj.text.replace(/\s+/g, ' ').slice(0, 200)
    const key = noteKey('in', contact.id, p.noteId)
    let outcome = 'dup' as 'stored' | 'dup' | 'full' | 'orphan'
    this.store.updateNotes(all => {
      if (all[key]) return
      let ask: Note | undefined
      if (p.kind === 'reply') {
        // Only an answer to a question this person was actually asked counts.
        ask = Object.values(all).find(n => n.dir === 'out' && answerable(n.kind) && n.id === p.replyTo && n.peerId === contact.id)
        if (!ask || ask.answer) {
          outcome = 'orphan'
          return
        }
      } else {
        const fresh = Object.values(all).filter(n => n.dir === 'in' && n.state === 'new')
        if (fresh.filter(n => n.peerId === contact.id).length >= MAX_NEW_PER_PEER || fresh.length >= MAX_NEW_TOTAL) {
          outcome = 'full'
          return
        }
      }
      all[key] = {
        key,
        id: p.noteId,
        dir: 'in',
        peerId: contact.id,
        kind: p.kind,
        subject,
        text: body.text,
        flags: [...new Set([...subj.flags, ...body.flags])],
        replyTo: p.replyTo,
        ticket: p.ticket,
        // On their question the ticket is theirs; on an answer it's the one we asked with.
        ticketBy: p.ticket ? (p.kind === 'reply' ? 'me' : 'them') : undefined,
        at: Math.min(ts, now),
        state: 'new',
        stateAt: now,
        session: { id: p.session.id.slice(0, 64), label: sanitizeLabel(p.session.label, 80), ...(p.session.kept ? { kept: true } : {}) },
      }
      if (ask) {
        advance(ask, 'answered', now)
        ask.answer = key
      }
      outcome = 'stored'
    })
    if (outcome === 'orphan') return this.drop('answer to a question nobody asked them', contact.id)
    if (outcome === 'full') return this.drop('too many unread messages from them', contact.id)
    // Another session stored it first; this one may still be where it belongs.
    if (outcome === 'dup') return void this.applyNote(key)
    const peer = this.peerView(contact.id)
    this.store.audit({ dir: 'in', event: 'note', note: p.noteId, kind: p.kind, replyTo: p.replyTo, peer: contact.id, topic: subject, text: body.text, flags: body.flags.length ? body.flags : undefined, session: this.session.id })
    // Delivery receipts are what make a queued message trustworthy, so they always go.
    this.ack({ peerId: contact.id, id: p.noteId }, 'delivered')
    this.emit({ kind: 'note', key, peer, noteKind: p.kind, subject })
    this.applyNote(key)
  }

  private onNoteAck(contact: Contact, p: PayloadOf<'note.ack'>) {
    const key = noteKey('out', contact.id, p.noteId)
    let moved: Note | null = null
    this.store.updateNotes(all => {
      const n = all[key]
      if (!n || (p.state === 'declined' && n.state === 'answered')) return
      if (advance(n, p.state)) moved = n
    })
    if (!moved) return
    const n = moved as Note
    this.store.audit({ dir: 'in', event: 'note.ack', note: p.noteId, state: p.state, peer: contact.id, session: this.session.id })
    this.emit({ kind: 'note.state', key, peer: this.peerView(contact.id), state: p.state, subject: n.subject })
  }

  // ---- files ----------------------------------------------------------------

  private fileLimit(targets: LinkState[]): number {
    const mb = Math.min(...targets.map(l => this.policyFor(l.peerId).maxFileMB))
    return Math.max(0, mb) * 1024 * 1024
  }

  // What the approval dialog shows, and the exact bytes that would be sent.
  inspectFile(id: string, path: string, cwd = process.cwd()): Inspection {
    const targets = this.targets(id)
    if (!targets.length) throw new Error(`no active link or group ${id}`)
    const abs = isAbsolute(path) ? path : resolve(cwd, path)
    const raw = new Uint8Array(readFileSync(abs))
    return inspectOutgoing(basename(abs), raw, {
      maxBytes: this.fileLimit(targets),
      dlp: this.policies.dlp(),
      allowSecrets: targets.every(l => l.allowSecrets),
    })
  }

  async sendFile(id: string, path: string, opts: { note?: string; expectSha?: string; cwd?: string } = {}): Promise<{ sent: Array<{ linkId: string; peer: string; chunks: number }>; name: string; size: number; sha256: string; notes: string[] }> {
    const targets = this.targets(id)
    if (!targets.length) throw new Error(`no active link or group ${id}`)
    if (!this.policies.features().features.files) throw new Error(`sending files is turned off (${this.policies.features().from.files})`)
    for (const l of targets) {
      const v = this.linkView(l)
      if (!v.caps.send) throw new Error(`your policy for ${v.peer.label} is "${v.role}", so your agent doesn't send to them`)
      if (!l.peerCaps.receive) throw new Error(`${v.peer.label}'s side doesn't take messages on this link`)
    }
    const f = this.inspectFile(id, path, opts.cwd)
    if (f.blocked) throw new SecretError(`blocked: ${f.blocked}`)
    if (opts.expectSha && opts.expectSha !== f.sha256) throw new Error('the file changed after your human approved it; nothing was sent')
    const note = opts.note?.trim() ? this.prepare(targets.map(l => ({ linkId: l.id })), opts.note) : null
    if (note?.blocked) throw new SecretError(`blocked: ${note.blocked}`)
    const chunks = Math.max(1, Math.ceil(f.data.length / CHUNK_BYTES))
    const sent: Array<{ linkId: string; peer: string; chunks: number }> = []
    for (const link of targets) {
      const card = this.cardFor(link.peerId)
      const fileId = randomId(9)
      const key = randomBytes(32)
      const meta: FileMeta = { fileId, name: f.name, kind: f.kind, mime: f.mime, size: f.data.length, sha256: f.sha256, chunks, key: b64u(key), note: note?.text }
      const seq = link.seqOut + 1
      const r = ratchet(link.sendKey, link.sendIndex, seq)
      const box = boxLinkText(r.mk, link.id, seq, JSON.stringify(meta))
      r.mk.fill(0)
      link.sendKey.fill(0)
      link.sendKey = r.chain
      link.sendIndex = seq
      link.seqOut = seq
      await this.sendTo(card, { t: 'link.file', sid: this.session.id, linkId: link.id, seq, box })
      for (let i = 0; i < chunks; i++) {
        const c = sealChunk(key, link.id, fileId, i, f.data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES))
        await this.sendPaced(card, { t: 'link.chunk', sid: this.session.id, linkId: link.id, fileId, index: i, n: c.n, ct: c.ct })
      }
      key.fill(0)
      link.lastActivity = Date.now()
      link.autoStreak = 0
      this.store.audit({ dir: 'out', event: 'file.sent', link: link.id, peer: link.peerId, seq, name: f.name, kind: f.kind, size: f.data.length, sha256: f.sha256, session: this.session.id })
      this.emit({ kind: 'file.sent', linkId: link.id, name: f.name, size: f.data.length })
      sent.push({ linkId: link.id, peer: this.peerView(link.peerId).label, chunks })
    }
    return { sent, name: f.name, size: f.data.length, sha256: f.sha256, notes: f.notes }
  }

  // Chunks go out back to back; when the relay says slow down, wait and retry.
  private async sendPaced(card: IdentityCard, payload: Payload) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendTo(card, payload)
      } catch (e) {
        if (!/rate limited/.test((e as Error).message) || attempt >= 60) throw e
        await new Promise(r => setTimeout(r, 250))
      }
    }
  }

  private onFileOffer(contact: Contact, p: PayloadOf<'link.file'>) {
    const link = this.links.get(p.linkId)
    if (!link || link.peerId !== contact.id || link.peerSession.id !== p.sid || p.seq <= link.seqIn) return
    let meta: FileMeta
    try {
      const r = ratchet(link.recvKey, link.recvIndex, p.seq)
      meta = JSON.parse(openLinkText(r.mk, link.id, p.seq, p.box)) as FileMeta
      r.mk.fill(0)
      link.recvKey.fill(0)
      link.recvKey = r.chain
      link.recvIndex = p.seq
    } catch {
      return this.drop('file offer failed to decrypt', contact.id)
    }
    link.seqIn = p.seq
    link.lastActivity = Date.now()
    const peer = this.peerView(contact.id)
    const policy = this.policyFor(contact.id)
    const refuse = (why: string) => {
      this.store.audit({ dir: 'in', event: 'file.refused', link: link.id, peer: contact.id, name: safeFileName(String(meta?.name ?? '')), reason: why, session: this.session.id })
      this.notice('message', link.id, `quietsync: ${peer.label} tried to send a file on link ${link.id}, and quietsync refused it: ${why}.`, { by: peer.label, linkId: link.id, isolation: policy.isolation })
    }
    const ok =
      meta && typeof meta.fileId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(meta.fileId) && typeof meta.size === 'number' && meta.size >= 0 &&
      typeof meta.sha256 === 'string' && /^[0-9a-f]{64}$/.test(meta.sha256) && typeof meta.key === 'string' && meta.chunks === Math.max(1, Math.ceil(meta.size / CHUNK_BYTES))
    if (!ok) return refuse('the offer was malformed')
    if (!policy.caps.receive) return refuse(`your role for them is "${policy.role}"`)
    if (!this.policies.features().features.files) return refuse('files are turned off by your profile')
    if (meta.size > policy.maxFileMB * 1024 * 1024) return refuse(`${formatSize(meta.size)} is over your ${policy.maxFileMB} MB limit`)
    if ([...this.transfers.values()].filter(t => t.linkId === link.id).length >= MAX_TRANSFERS_PER_LINK) return refuse('too many files arriving at once')
    if (this.transfers.has(meta.fileId)) return
    const dir = join(this.store.inboxDir(), '.incoming')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = join(dir, `${meta.fileId}.part`)
    const fd = openSync(tmp, 'w', 0o600)
    const note = meta.note ? sanitizeInbound(String(meta.note)) : null
    if (note) meta.note = note.text
    this.transfers.set(meta.fileId, { linkId: link.id, peerId: contact.id, meta, key: unb64u(meta.key), got: new Set(), tmp, fd, at: Date.now(), noteFlags: note?.flags ?? [] })
    this.store.audit({ dir: 'in', event: 'file.offer', link: link.id, peer: contact.id, name: safeFileName(meta.name), size: meta.size, sha256: meta.sha256, session: this.session.id })
  }

  private onChunk(contact: Contact, p: PayloadOf<'link.chunk'>) {
    const t = this.transfers.get(p.fileId)
    if (!t || t.peerId !== contact.id || t.linkId !== p.linkId || p.index >= t.meta.chunks || t.got.has(p.index)) return
    let data: Uint8Array
    try {
      data = openChunk(t.key, t.linkId, p.fileId, p.index, p.n, p.ct)
    } catch {
      return this.dropTransfer(p.fileId, 'a file chunk failed to decrypt')
    }
    const expected = p.index === t.meta.chunks - 1 ? t.meta.size - p.index * CHUNK_BYTES : CHUNK_BYTES
    if (data.length !== Math.max(0, expected)) return this.dropTransfer(p.fileId, 'a file chunk had the wrong size')
    writeSync(t.fd, data, 0, data.length, p.index * CHUNK_BYTES)
    t.got.add(p.index)
    if (t.got.size === t.meta.chunks) this.finishTransfer(p.fileId)
  }

  private dropTransfer(fileId: string, reason: string) {
    const t = this.transfers.get(fileId)
    if (!t) return
    this.transfers.delete(fileId)
    t.key.fill(0)
    try {
      closeSync(t.fd)
    } catch {}
    rmSync(t.tmp, { force: true })
    this.drop(reason, t.peerId)
    this.store.audit({ dir: 'in', event: 'file.failed', link: t.linkId, peer: t.peerId, name: safeFileName(t.meta.name), reason, session: this.session.id })
  }

  private finishTransfer(fileId: string) {
    const t = this.transfers.get(fileId)!
    this.transfers.delete(fileId)
    t.key.fill(0)
    closeSync(t.fd)
    const data = new Uint8Array(readFileSync(t.tmp))
    if (sha256Hex(data) !== t.meta.sha256) {
      rmSync(t.tmp, { force: true })
      return this.drop('a received file did not match its fingerprint', t.peerId)
    }
    const peer = this.peerView(t.peerId)
    const dir = join(this.store.inboxDir(), safeFileName(peer.label))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
    let dest = join(dir, `${stamp}-${safeFileName(t.meta.name)}`)
    for (let i = 2; existsSync(dest); i++) dest = join(dir, `${stamp}-${i}-${safeFileName(t.meta.name)}`)
    renameSync(t.tmp, dest)
    chmodSync(dest, 0o600)
    const kind = sniff(data).kind
    const zip = kind === 'zip' ? readZip(data) : undefined
    const record: ReceivedFile = { path: dest, name: safeFileName(t.meta.name), kind, size: data.length, sha256: t.meta.sha256, by: peer.label, peerId: t.peerId, linkId: t.linkId, at: Date.now() }
    this.store.update<Record<string, ReceivedFile>>('inbox-index.json', {}, all => {
      all[dest] = record
    })
    const link = this.links.get(t.linkId)
    this.store.audit({ dir: 'in', event: 'file.received', link: t.linkId, peer: t.peerId, name: record.name, kind, size: data.length, sha256: t.meta.sha256, path: dest, session: this.session.id })
    this.notice(
      'message',
      t.linkId,
      frameFile({
        peer,
        linkId: t.linkId,
        description: describeIncoming({ ...t.meta, kind, size: data.length }, zip),
        path: dest,
        note: t.meta.note,
        noteFlags: t.noteFlags,
        canReply: !!link && this.policyFor(t.peerId).caps.send && link.peerCaps.receive,
      }),
      { by: peer.label, linkId: t.linkId, isolation: this.policyFor(t.peerId).isolation },
    )
    this.emit({ kind: 'file', linkId: t.linkId, peer, name: record.name, size: data.length, path: dest })
    if (this.policies.features().features.receipts) {
      const l = this.links.get(t.linkId)
      if (l) void this.sendTo(this.cardFor(t.peerId), { t: 'link.ack', sid: this.session.id, linkId: t.linkId, seq: l.seqIn }).catch(() => {})
    }
  }

  receivedFiles(): ReceivedFile[] {
    return Object.values(this.store.read<Record<string, ReceivedFile>>('inbox-index.json', {})).sort((a, b) => b.at - a.at)
  }

  // Who a file in the inbox came from, for marking a turn that reads it.
  fileOwner(path: string): ReceivedFile | null {
    const index = this.store.read<Record<string, ReceivedFile>>('inbox-index.json', {})
    const abs = resolve(path)
    return index[abs] ?? Object.values(index).find(r => abs.startsWith(`${r.path}`)) ?? null
  }

  // Content from someone else's file is entering this session: it now runs at peer privilege.
  touchPeerContent(path: string): void {
    const owner = this.fileOwner(path)
    const by = owner?.by ?? 'a file someone sent'
    const linkId = owner?.linkId ?? 'inbox'
    this.taintFrom(by, linkId, 'read a received file', owner ? this.policyFor(owner.peerId).isolation : 'strict')
  }

  async close(id: string, reason: Reason = 'done'): Promise<void> {
    const targets = this.targets(id)
    if (!targets.length) {
      const outs = [...this.outgoing.values()].filter(o => o.id === id || o.group?.id === id)
      for (const out of outs) {
        this.outgoing.delete(out.id)
        out.ephPriv.fill(0)
        await this.sendTo(this.cardFor(out.peerId), { t: 'link.close', sid: this.session.id, linkId: out.id, reason: 'withdrawn' }).catch(() => {})
      }
      return
    }
    for (const link of targets) {
      this.links.delete(link.id)
      wipe(link)
      await this.sendTo(this.cardFor(link.peerId), { t: 'link.close', sid: this.session.id, linkId: link.id, reason, to: link.peerSession.id }).catch(() => {})
      this.store.audit({ dir: 'out', event: 'link.close', link: link.id, peer: link.peerId, reason, session: this.session.id })
      this.emit({ kind: 'closed', linkId: link.id, peer: this.peerView(link.peerId), topic: link.topic, by: 'me', reason: reasonText(reason) })
    }
  }

  // Human-only: callers must have verified a human made this choice.
  setLinkPolicy(id: string, patch: { send?: SendPolicy; allowSecrets?: boolean }): LinkView[] {
    const targets = this.targets(id)
    if (!targets.length) throw new Error(`no active link ${id}`)
    const f = this.policies.features()
    if (patch.send === 'auto' && (this.policies.managed?.ceiling?.send === 'ask' || !f.features.autoSend)) throw new Error(`auto-send is turned off (${f.from.autoSend})`)
    if (patch.allowSecrets && !f.features.secretsOverride) throw new Error(`letting secrets through is turned off (${f.from.secretsOverride})`)
    for (const link of targets) {
      if (patch.send) link.sendOverride = patch.send
      if (patch.allowSecrets !== undefined) link.allowSecrets = patch.allowSecrets
      link.autoStreak = 0
      const v = this.linkView(link)
      this.store.audit({ event: 'policy', link: link.id, send: v.send, allowSecrets: v.allowSecrets, session: this.session.id })
      this.emit({ kind: 'policy', linkId: link.id, send: v.send, allowSecrets: v.allowSecrets })
    }
    return targets.map(l => this.linkView(l))
  }

  // Human-only. Narrows this session: pause new requests, or a role like
  // "listener" for the rest of the session.
  setSessionMode(opts: { paused?: boolean; mode?: Role | null }): void {
    if (opts.paused !== undefined) this.paused = opts.paused
    if (opts.mode !== undefined) {
      this.mode = opts.mode
      this.policies.setSession(opts.mode ? { role: opts.mode } : undefined)
    }
    this.store.audit({ event: 'session.mode', paused: this.paused, mode: this.mode, session: this.session.id })
  }

  // ---- pairing (separate people) -------------------------------------------

  createContactInvite(ttlMs = 24 * 3600 * 1000): { code: string; inviteId: string } {
    const no = this.externalAllowed()
    if (no) throw new Error(`can't make a contact invite: ${no}. Use a team instead.`)
    const relay = this.requireRelayUrl()
    const inviteId = randomId(9)
    const secret = b64u(randomBytes(16))
    const exp = Date.now() + ttlMs
    this.store.updateInvites(all => {
      all[inviteId] = { kind: 'contact', secret, exp, createdAt: Date.now() }
    })
    const inv: ContactInvite = { k: 'contact', r: relay, p: this.identity.card, i: inviteId, s: secret, e: exp }
    return { code: encodeInvite(inv), inviteId }
  }

  private requireRelayUrl(): string {
    if (!this.relayUrl) throw new Error('no relay configured, run `quietsync setup`')
    return this.relayUrl
  }

  waitForPairing(inviteId: string, timeoutMs: number): Promise<Contact | null> {
    return new Promise(resolve => {
      const t = setTimeout(() => {
        off()
        resolve(null)
      }, timeoutMs)
      const off = this.on(e => {
        if (e.kind !== 'paired') return
        const inv = this.store.invites()[inviteId]
        if (!inv?.usedBy) return
        clearTimeout(t)
        off()
        resolve(this.contact(inv.usedBy))
      })
    })
  }

  private async onPairRequest(from: string, p: PayloadOf<'pair.request'>) {
    if (!verifyCard(p.card) || p.card.sign !== from) return this.drop('pair request with a bad card', from)
    const no = this.externalAllowed()
    if (no) return this.drop(`pair request refused: ${no}`, from)
    let ok = false
    let reason = 'invite not found'
    this.store.updateInvites(all => {
      const inv = all[p.inviteId]
      if (!inv || inv.kind !== 'contact') return
      if (inv.usedBy && inv.usedBy !== from) return void (reason = 'invite already used')
      if (inv.exp < Date.now()) return void (reason = 'invite expired')
      const expect = inviteProof('pair', inv.secret, p.inviteId, from)
      if (!constantTimeEqual(new TextEncoder().encode(expect), new TextEncoder().encode(p.proof))) return void (reason = 'bad proof')
      inv.usedBy = from
      ok = true
    })
    const relay = p.relay && !this.policies.relayCheck(p.relay) ? p.relay : undefined
    if (!ok) {
      this.drop(`pair request refused: ${reason}`, from)
      if (reason !== 'invite not found') await this.sendTo(p.card, { t: 'pair.reject', sid: this.session.id, inviteId: p.inviteId, reason }, relay ?? null).catch(() => {})
      return
    }
    this.addContact(p.card, 'external', 'invite', { relay })
    await this.sendTo(p.card, { t: 'pair.accept', sid: this.session.id, inviteId: p.inviteId, card: this.identity.card, relay: this.relayUrl ?? undefined }, relay ?? null)
    this.emit({ kind: 'paired', contact: p.card.name, safety: safetyNumber(this.identity.card.sign, from) })
  }

  private onPairAccept(from: string, p: PayloadOf<'pair.accept'>) {
    const pending = this.store.pendingPairs()[p.inviteId]
    if (!pending || pending.expected !== from || !verifyCard(p.card) || p.card.sign !== from) return
    this.addContact(p.card, 'external', 'invite', { relay: pending.relay })
    this.store.updatePendingPairs(all => {
      delete all[p.inviteId]
    })
    this.emit({ kind: 'paired', contact: p.card.name, safety: safetyNumber(this.identity.card.sign, from) })
  }

  private addContact(card: IdentityCard, rel: Rel, via: Contact['via'], extra: Partial<Contact> = {}) {
    if (card.sign === this.identity.card.sign || this.store.rotations()[card.sign]) return
    this.store.updateContacts(all => {
      const prev = all[card.sign]
      all[card.sign] = {
        id: card.sign,
        name: card.name,
        card,
        rel: prev?.rel === 'team' && rel === 'external' ? 'team' : rel,
        via: prev?.via ?? via,
        teams: [...new Set([...(prev?.teams ?? []), ...(extra.teams ?? [])])],
        handle: extra.handle ?? prev?.handle,
        addedAt: prev?.addedAt ?? Date.now(),
        relay: extra.relay ?? prev?.relay,
        // What the human set stays: blocking, a verified safety number, the contact book.
        blocked: prev?.blocked,
        verified: prev?.verified,
        role: prev?.role,
        note: prev?.note,
      }
    })
  }

  async pair(code: string, timeoutMs = 60_000): Promise<{ contact: Contact | null; safety: string; queued: boolean }> {
    const inv = decodeInvite(code)
    if (inv.k !== 'contact') throw new Error(`that's a ${inv.k} code, not a contact invite`)
    if (inv.p.sign === this.identity.card.sign) throw new Error("that's your own invite")
    const no = this.externalAllowed()
    if (no) throw new Error(`can't pair: ${no}`)
    const problem = this.policies.relayCheck(inv.r)
    if (problem) throw new Error(problem)
    this.store.updatePendingPairs(all => {
      all[inv.i] = { expected: inv.p.sign, relay: inv.r, at: Date.now() }
    })
    const done = new Promise<Payload | null>(resolve => {
      const t = setTimeout(() => resolve(null), timeoutMs)
      const settle = (p: Payload) => {
        clearTimeout(t)
        this.waiters.delete(`pair.accept:${inv.i}`)
        this.waiters.delete(`pair.reject:${inv.i}`)
        resolve(p)
      }
      this.waiters.set(`pair.accept:${inv.i}`, settle)
      this.waiters.set(`pair.reject:${inv.i}`, settle)
    })
    const res = await this.sendTo(
      inv.p,
      {
        t: 'pair.request',
        sid: this.session.id,
        inviteId: inv.i,
        proof: inviteProof('pair', inv.s, inv.i, this.identity.card.sign),
        card: this.identity.card,
        relay: this.relayUrl ?? undefined,
      },
      inv.r,
    )
    const reply = await done
    if (reply?.t === 'pair.reject') {
      this.store.updatePendingPairs(all => {
        delete all[inv.i]
      })
      throw new Error(`${inv.p.name} refused the pairing: ${sanitizeLabel(reply.reason, 200)}`)
    }
    return { contact: this.contact(inv.p.sign), safety: safetyNumber(this.identity.card.sign, inv.p.sign), queued: !reply && res.queued }
  }

  // ---- devices (same person, another machine) ------------------------------

  createDeviceInvite(ttlMs = 10 * 60 * 1000): { code: string; inviteId: string } {
    const f = this.policies.features()
    if (!f.features.devices) throw new Error(`copying your identity to another machine is turned off (${f.from.devices})`)
    const relay = this.requireRelayUrl()
    const inviteId = randomId(9)
    const secret = b64u(randomBytes(16))
    const exp = Date.now() + ttlMs
    this.store.updateInvites(all => {
      all[inviteId] = { kind: 'device', secret, exp, createdAt: Date.now() }
    })
    const inv: DeviceInvite = { k: 'device', r: relay, p: this.identity.card, i: inviteId, s: secret, e: exp }
    return { code: encodeInvite(inv), inviteId }
  }

  // Waits for the new device to show up, then hands it this identity. Only
  // runs while the human is sitting at `quietsync device add`.
  waitDeviceJoin(inviteId: string, timeoutMs: number): Promise<{ deviceName: string } | null> {
    return new Promise(resolve => {
      const t = setTimeout(() => {
        this.deviceWaiters.delete(inviteId)
        resolve(null)
      }, timeoutMs)
      this.deviceWaiters.set(inviteId, async (p, from) => {
        const inv = this.store.invites()[inviteId]
        if (!inv || inv.kind !== 'device' || inv.usedBy || inv.exp < Date.now()) return
        if (!verifyCard(p.card) || p.card.sign !== from) return
        const expect = inviteProof('device', inv.secret, inviteId, from)
        if (!constantTimeEqual(new TextEncoder().encode(expect), new TextEncoder().encode(p.proof))) return this.drop('device join with a bad proof', from)
        this.store.updateInvites(all => {
          all[inviteId]!.usedBy = from
        })
        const bundle = JSON.stringify({
          identity: serializeIdentity(this.identity),
          contacts: this.store.contacts(),
          teams: this.store.teams(),
          policy: this.store.policyFile(),
          relay: this.relayUrl,
        })
        await this.sendTo(p.card, { t: 'device.grant', sid: this.session.id, inviteId, bundle }, this.relayUrl)
        clearTimeout(t)
        this.deviceWaiters.delete(inviteId)
        this.store.audit({ event: 'device.added', deviceName: sanitizeLabel(p.deviceName, 64) })
        resolve({ deviceName: sanitizeLabel(p.deviceName, 64) })
      })
    })
  }

  static async joinDevice(store: Store, code: string, deviceName: string, timeoutMs = 120_000): Promise<Identity> {
    if (store.hasIdentity()) throw new Error(`this machine already has an identity in ${store.home}`)
    const inv = decodeInvite(code)
    if (inv.k !== 'device') throw new Error(`that's a ${inv.k} code, not a device code`)
    const temp = createIdentity('new-device')
    const node = new AgentNode({ store, session: { id: `device-join-${randomId(4)}`, label: 'device join', agent: 'cli', device: deviceName }, relayUrl: inv.r, identity: temp })
    await node.start()
    try {
      const grant = new Promise<PayloadOf<'device.grant'> | null>(resolve => {
        const t = setTimeout(() => resolve(null), timeoutMs)
        node.waiters.set(`device.grant:${inv.i}`, (p, from) => {
          if (p.t !== 'device.grant' || from !== inv.p.sign) return
          clearTimeout(t)
          resolve(p)
        })
      })
      await node.sendTo(
        inv.p,
        {
          t: 'device.request',
          sid: node.session.id,
          inviteId: inv.i,
          proof: inviteProof('device', inv.s, inv.i, temp.card.sign),
          deviceName,
          card: temp.card,
        },
        inv.r,
      )
      const g = await grant
      if (!g) throw new Error('timed out, is `quietsync device add` still waiting on the other machine?')
      const bundle = JSON.parse(g.bundle) as {
        identity: StoredIdentity
        contacts: Record<string, Contact>
        teams: Record<string, StoredTeam>
        policy?: PolicyFile
        relay: string
      }
      const id = deserializeIdentity(bundle.identity)
      if (id.card.sign !== inv.p.sign || !verifyCard(id.card)) throw new Error('received identity does not match the code')
      store.saveIdentity(id)
      store.write('contacts.json', bundle.contacts)
      store.write('teams.json', bundle.teams)
      if (bundle.policy) store.write('policy.json', bundle.policy)
      store.setConfig({ relay: bundle.relay ?? inv.r, deviceName } satisfies Partial<Config>)
      return id
    } finally {
      node.pool?.close()
      for (const t of node.timers) clearInterval(t)
    }
  }

  // ---- teams ---------------------------------------------------------------

  private teamRelay(team: StoredTeam): RelayClient {
    return this.requirePool().get(team.relay ?? this.relayUrl)
  }

  async teamCreate(name: string, handle = this.identity.name): Promise<StoredTeam> {
    const relayUrl = this.requireRelayUrl()
    const relay = this.requirePool().get(relayUrl)
    const { card, key } = createTeam(name, { org: this.policies.orgTag ?? undefined })
    const cap = issueCap(card, key.priv, 60_000, { max: 1 })
    const membership = createMembership(this.identity, card, cap, handle, { relay: relayUrl })
    await relay.dirPut(card.teamId, { kind: 'card', card })
    await relay.dirPut(card.teamId, { kind: 'member', m: membership })
    await relay.dirPut(card.teamId, { kind: 'admit', a: createAdmission(card, key.priv, membership) })
    const team: StoredTeam = { card, adminKey: b64u(key.priv), handle, membership, relay: relayUrl }
    this.store.updateTeams(all => {
      all[card.teamId] = team
    })
    return team
  }

  teamByRef(ref: string): StoredTeam {
    const teams = Object.values(this.store.teams())
    const t = teams.find(t => t.card.teamId === ref || t.card.name === ref)
    if (!t) throw new Error(`not in a team called "${ref}"`)
    return t
  }

  teamInvite(ref: string, ttlMs = 7 * 24 * 3600 * 1000, max?: number): string {
    const team = this.teamByRef(ref)
    if (!team.adminKey) throw new Error(`only the team creator can invite to ${team.card.name} for now`)
    const cap = issueCap(team.card, unb64u(team.adminKey), ttlMs, { max })
    return encodeInvite({ k: 'team', r: team.relay ?? this.requireRelayUrl(), team: team.card, cap })
  }

  async teamJoin(code: string, handle = this.identity.name): Promise<{ team: StoredTeam; members: number; admitted: boolean }> {
    const inv = decodeInvite(code)
    if (inv.k !== 'team') throw new Error(`that's a ${inv.k} code, not a team invite`)
    if (!verifyTeamCard(inv.team)) throw new Error('bad team card')
    if (this.policies.features().features.orgOnly && !this.policies.joinAllowed(inv.team)) {
      throw new Error(`team ${inv.team.name} isn't tied to ${this.policies.org ? `your org (${this.policies.org.name})` : 'your org'}, and you can only join your org's teams`)
    }
    const problem = this.policies.relayCheck(inv.r)
    if (problem) throw new Error(problem)
    const membership = createMembership(this.identity, inv.team, inv.cap, handle, { relay: this.relayUrl ?? undefined })
    await this.requirePool().get(inv.r).dirPut(inv.team.teamId, { kind: 'member', m: membership })
    const team: StoredTeam = { card: inv.team, handle, membership, relay: inv.r }
    this.store.updateTeams(all => {
      all[inv.team.teamId] = { ...all[inv.team.teamId], ...team }
    })
    const { members } = await this.teamSyncOne(team)
    const admitted = members.some(m => m.card.sign === this.identity.card.sign)
    if (!admitted) this.waitForAdmission(team.card.teamId)
    return { team, members: members.length, admitted }
  }

  // Until the admin's quietsync admits us, look again every 20s (for up to 30 min).
  private waitForAdmission(teamId: string) {
    const until = Date.now() + 30 * 60_000
    const t = setInterval(async () => {
      const team = this.store.teams()[teamId]
      if (!team || Date.now() > until) return clearInterval(t)
      const { members } = await this.teamSyncOne(team).catch(() => ({ members: [] as Array<{ card: IdentityCard }> }))
      if (members.some(m => m.card.sign === this.identity.card.sign)) {
        clearInterval(t)
        this.store.audit({ event: 'team.admitted.me', team: team.card.name })
      }
    }, 20_000)
    t.unref?.()
    this.timers.push(t)
  }

  // Pulls a team's directory, admits pending joins if we hold the team key,
  // and turns verified members into contacts.
  private async teamSyncOne(team: StoredTeam) {
    const relay = this.teamRelay(team)
    let records = await relay.dirGet(team.card.teamId)
    let state = resolveTeamState(team.card, records)
    if (team.adminKey) {
      const key = unb64u(team.adminKey)
      const admit = admissible(state, records)
      for (const m of admit) await relay.dirPut(team.card.teamId, { kind: 'admit', a: createAdmission(team.card, key, m) })
      if (admit.length) {
        this.store.audit({ event: 'team.admitted', team: team.card.name, members: admit.map(m => m.handle) })
        records = await relay.dirGet(team.card.teamId)
        state = resolveTeamState(team.card, records)
      }
    }
    // A member who rotated keys stays listed under the old key until they rejoin;
    // they count as the new one here.
    const rotated = this.store.rotations()
    const current = (id: string) => {
      for (let i = 0; i < 8 && rotated[id]; i++) id = rotated[id]!
      return id
    }
    const ids = new Set(state.members.map(m => current(m.card.sign)))
    for (const m of state.members) {
      const now = current(m.card.sign)
      if (now === m.card.sign) {
        this.addContact(m.card, 'team', 'team', { teams: [team.card.teamId], handle: m.handle, relay: m.relay && !this.policies.relayCheck(m.relay) ? m.relay : undefined })
        continue
      }
      this.store.updateContacts(all => {
        const c = all[now]
        if (c && !c.teams.includes(team.card.teamId)) c.teams = [...c.teams, team.card.teamId]
        delete all[m.card.sign]
      })
    }
    this.store.updateContacts(all => {
      for (const c of Object.values(all)) {
        if (!c.teams.includes(team.card.teamId) || ids.has(c.id)) continue
        c.teams = c.teams.filter(t => t !== team.card.teamId)
        if (!c.teams.length && c.via === 'team') delete all[c.id]
        else if (!c.teams.length) c.rel = 'external'
      }
    })
    this.store.updateTeams(all => {
      const t = all[team.card.teamId]
      if (!t) return
      t.syncedAt = Date.now()
      // Profiles only move forward: an older record (or none) coming back from
      // the relay doesn't undo the newest one we've seen.
      if (state.policy && (!t.policy || state.policy.at > t.policy.at)) t.policy = state.policy
      else if (t.policy && (!state.policy || state.policy.at < t.policy.at)) this.store.audit({ event: 'team.policy.stale', team: team.card.name })
    })
    this.store.auditLevel = this.policies.features().features.audit
    return state
  }

  // Admin only: publish the profile every member of this team runs under.
  async teamSetProfile(ref: string, choice: ProfileChoice): Promise<void> {
    const team = this.teamByRef(ref)
    if (!team.adminKey) throw new Error(`only the team creator can set ${team.card.name}'s profile`)
    await this.teamRelay(team).dirPut(team.card.teamId, { kind: 'policy', p: createTeamPolicy(team.card, unb64u(team.adminKey), choice) })
    this.store.audit({ event: 'team.profile', team: team.card.name, profile: choice.profile, features: choice.features })
    await this.teamSync(team.card.teamId)
  }

  // Human-only (terminal, after comparing safety numbers out of band).
  markVerified(ref: string, verified = true): Contact {
    const c = this.resolvePeer(ref)
    if (!c || c.rel === 'self') throw new Error(`no contact "${ref}"`)
    this.store.updateContacts(all => {
      if (all[c.id]) all[c.id]!.verified = verified
    })
    this.store.audit({ event: verified ? 'contact.verified' : 'contact.unverified', peer: c.id })
    return this.store.contacts()[c.id]!
  }

  async teamSync(only?: string): Promise<number> {
    let count = 0
    for (const team of Object.values(this.store.teams())) {
      if (only && team.card.teamId !== only) continue
      count = (await this.teamSyncOne(team)).members.length
    }
    return count
  }

  async teamState(ref: string) {
    const team = this.teamByRef(ref)
    return { team, ...resolveTeamState(team.card, await this.teamRelay(team).dirGet(team.card.teamId)) }
  }

  async teamRemove(ref: string, memberRef: string): Promise<void> {
    const team = this.teamByRef(ref)
    if (!team.adminKey) throw new Error('only the team creator can remove members')
    const c = this.resolvePeer(memberRef)
    if (!c || !c.teams.includes(team.card.teamId)) throw new Error(`${memberRef} is not in ${team.card.name}`)
    await this.teamRelay(team).dirPut(team.card.teamId, { kind: 'revoke', r: createRevocation(team.card, unb64u(team.adminKey), c.id) })
    await this.teamSync(team.card.teamId)
  }
}
