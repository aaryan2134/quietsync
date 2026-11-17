import { b64u, utf8 } from './bytes.ts'
import { randomId, sign } from './crypto.ts'
import type { Envelope } from './envelope.ts'
import type { Identity } from './identity.ts'
import type { TeamRecord } from './team.ts'

export const RELAY_PROTOCOL = 'quietsync.v1'

// The login signature names the relay's host, so a relay someone else runs
// can't pass it on to log in as you somewhere else.
export function relayAuthBytes(host: string, nonce: string): Uint8Array {
  return utf8(`quietsync/v1/relay-auth|${host.toLowerCase()}|${nonce}`)
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export type SendResult = { delivered: number; queued: boolean }

export type RelayClientOptions = {
  onEnvelope: (env: Envelope) => void
  onStatus?: (connected: boolean, detail?: string) => void
  requestTimeoutMs?: number
  // Stable per machine, so the relay keeps waiting messages for each of a person's devices.
  device?: string
}

// One authenticated WebSocket to a relay. Reconnects with backoff and holds
// requests made while offline until the link is back (or they time out).
export class RelayClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private outbox: Array<() => void> = []
  private backoff = 500
  private closed = false
  private readyWaiters: Array<() => void> = []
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private acks: string[] = []
  private ackTimer: ReturnType<typeof setTimeout> | null = null

  // Batched, so a big file's chunks don't cost one frame each.
  private ack(id: string) {
    this.acks.push(id)
    if (this.acks.length >= 200) return this.flushAcks()
    this.ackTimer ??= setTimeout(() => this.flushAcks(), 50)
  }

  private flushAcks() {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    const ids = this.acks.splice(0)
    if (ids.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'ack', ids }))
  }
  connected = false

  constructor(
    readonly url: string,
    private identity: Identity,
    private opts: RelayClientOptions,
  ) {}

  start(): Promise<void> {
    this.open()
    return this.waitReady()
  }

  waitReady(timeoutMs = 15_000): Promise<void> {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`could not reach relay ${this.url}`)), timeoutMs)
      this.readyWaiters.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private open() {
    if (this.closed) return
    const ws = new WebSocket(this.url, RELAY_PROTOCOL)
    this.ws = ws
    ws.onmessage = ev => this.onFrame(String(ev.data))
    ws.onclose = () => {
      if (this.ws !== ws) return
      const was = this.connected
      this.connected = false
      this.ws = null
      if (was) this.opts.onStatus?.(false, 'disconnected')
      if (this.heartbeat) clearInterval(this.heartbeat)
      if (!this.closed) {
        // Jitter, so a relay restart isn't met by every client at once.
        setTimeout(() => this.open(), this.backoff * (0.5 + Math.random()))
        this.backoff = Math.min(this.backoff * 2, 30_000)
      }
    }
    ws.onerror = () => {}
  }

  private onFrame(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.t === 'challenge' && typeof msg.nonce === 'string') {
      const sig = b64u(sign(relayAuthBytes(new URL(this.url).host, msg.nonce), this.identity.signing.priv))
      this.ws?.send(JSON.stringify({ t: 'auth', pub: this.identity.card.sign, sig, ack: true, ...(this.opts.device ? { device: this.opts.device } : {}) }))
      return
    }
    if (msg.t === 'ready') {
      this.connected = true
      this.backoff = 500
      this.startHeartbeat()
      this.opts.onStatus?.(true)
      for (const w of this.readyWaiters.splice(0)) w()
      for (const f of this.outbox.splice(0)) f()
      return
    }
    if (msg.t === 'env' && msg.env) {
      // Handled synchronously, so by the ack it's stored; a crash before that means the relay sends it again.
      try {
        this.opts.onEnvelope(msg.env as Envelope)
      } finally {
        if (typeof msg.env.id === 'string') this.ack(msg.env.id)
      }
      return
    }
    if (msg.t === 'res' && typeof msg.rid === 'string') {
      const p = this.pending.get(msg.rid)
      if (!p) return
      this.pending.delete(msg.rid)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg)
      else p.reject(new Error(msg.error || 'relay refused the request'))
      return
    }
    if (msg.t === 'err') this.opts.onStatus?.(this.connected, String(msg.error))
  }

  private request<T>(frame: Record<string, unknown>): Promise<T> {
    const rid = randomId(8)
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        reject(new Error('relay request timed out'))
      }, this.opts.requestTimeoutMs ?? 30_000)
      this.pending.set(rid, { resolve, reject, timer })
      const go = () => this.ws?.send(JSON.stringify({ ...frame, rid }))
      if (this.connected) go()
      else this.outbox.push(go)
    })
  }

  // A connection can die without a close event (sleep, network change). Ping
  // every 25s and reconnect if the relay doesn't answer within 10s.
  private startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    const ws = this.ws
    this.heartbeat = setInterval(() => {
      if (!this.connected || this.ws !== ws) return
      const rid = randomId(8)
      const timer = setTimeout(() => {
        this.pending.delete(rid)
        if (this.ws === ws) ws?.close()
      }, 10_000)
      this.pending.set(rid, { resolve: () => {}, reject: () => {}, timer })
      ws?.send(JSON.stringify({ t: 'ping', rid }))
    }, 25_000)
    this.heartbeat.unref?.()
  }

  async send(env: Envelope): Promise<SendResult> {
    const res = await this.request<{ delivered: number; queued: boolean }>({ t: 'send', env })
    return { delivered: res.delivered, queued: res.queued }
  }

  async dirPut(team: string, record: TeamRecord): Promise<void> {
    await this.request({ t: 'dir.put', team, record })
  }

  async dirGet(team: string): Promise<TeamRecord[]> {
    const res = await this.request<{ records: TeamRecord[] }>({ t: 'dir.get', team })
    return res.records
  }

  close() {
    this.flushAcks()
    this.closed = true
    this.connected = false
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('relay client closed'))
    }
    this.pending.clear()
    this.ws?.close()
    this.ws = null
  }
}

// The home relay (where this identity listens) plus lazily opened connections
// to contacts' relays, so people on different relays can still link. Extra
// connections close after a few idle minutes.
export class RelayPool {
  home: RelayClient | null = null
  private others = new Map<string, { client: RelayClient; used: number }>()
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(
    readonly homeUrl: string | null,
    private identity: Identity,
    private opts: RelayClientOptions & { check?: (url: string) => string | null; idleMs?: number },
  ) {}

  get connected(): boolean {
    return this.home?.connected ?? false
  }

  start(): Promise<void> {
    if (!this.homeUrl) return Promise.resolve()
    this.home = new RelayClient(this.homeUrl, this.identity, this.opts)
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref?.()
    return this.home.start()
  }

  get(url?: string | null): RelayClient {
    if (!url || url === this.homeUrl) {
      if (!this.home) throw new Error('no relay configured, run `quietsync setup`')
      return this.home
    }
    const problem = this.opts.check?.(url)
    if (problem) throw new Error(problem)
    let entry = this.others.get(url)
    if (!entry) {
      const client = new RelayClient(url, this.identity, { ...this.opts, onStatus: undefined })
      client.start().catch(() => {})
      entry = { client, used: Date.now() }
      this.others.set(url, entry)
    }
    entry.used = Date.now()
    return entry.client
  }

  private sweep(now = Date.now()) {
    for (const [url, e] of this.others) {
      if (now - e.used > (this.opts.idleMs ?? 5 * 60_000)) {
        e.client.close()
        this.others.delete(url)
      }
    }
  }

  close() {
    if (this.sweeper) clearInterval(this.sweeper)
    this.home?.close()
    for (const e of this.others.values()) e.client.close()
    this.others.clear()
  }
}
