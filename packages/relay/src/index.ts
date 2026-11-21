import { Database } from 'bun:sqlite'
import type { ServerWebSocket } from 'bun'
import {
  isEnvelope,
  MAX_ENVELOPE_BYTES,
  randomId,
  recordKey,
  relayAuthBytes,
  RELAY_PROTOCOL,
  unb64u,
  verify,
  verifyAdmission,
  verifyMembership,
  verifyRevocation,
  verifyTeamCard,
  verifyTeamPolicy,
  type Envelope,
  type TeamCard,
  type TeamRecord,
} from '@quietsync/core'

export type RelayOptions = {
  port?: number
  hostname?: string
  dbPath?: string
  queueTtlMs?: number
  maxQueuePerRecipient?: number
  maxQueuePerSender?: number
  maxQueueTotal?: number
  maxConnectionsPerKey?: number
  rate?: { burst: number; perSecond: number }
  connectRate?: { burst: number; perMinute: number }
  // Members-only: only these keys (plus admitted members of teams hosted here)
  // get a mailbox and the team directory. Anyone else may only deliver to members.
  allowKeys?: Iterable<string>
  trustProxy?: boolean
  // The host clients dial, when it differs from the Host header the relay sees.
  publicHost?: string
  maxTeamMembers?: number
  maxPendingJoins?: number
  log?: (msg: string) => void
}

type Conn = {
  id: string
  ip: string
  host: string
  pub: string | null
  member: boolean
  nonce: string
  // The client confirms each envelope it stored; until then the relay keeps it.
  acks: boolean
  // The machine this connection is on; waiting messages are kept per device.
  device: string
  tokens: number
  refill: number
}

export type RelayStats = { connections: number; keys: number; queued: number; delivered: number; rejected: number }
export type Relay = { url: string; port: number; stop: () => void; stats: () => RelayStats; allow: (keys: Iterable<string>) => void }

// Routes sealed envelopes between identities. It never sees plaintext: it
// checks who is connected (signature over a nonce), forwards by recipient key,
// queues for offline recipients, and hosts signed team directory records.
// A device not seen for a week stops holding up deletion of its owner's waiting messages.
const DEVICE_TTL_MS = 7 * 24 * 3600 * 1000

export function startRelay(opts: RelayOptions = {}): Relay {
  const log = opts.log ?? (() => {})
  const ttl = opts.queueTtlMs ?? 7 * 24 * 3600 * 1000
  const maxQueue = opts.maxQueuePerRecipient ?? 1000
  const maxPerSender = opts.maxQueuePerSender ?? 100
  const maxTotal = opts.maxQueueTotal ?? 200_000
  const maxConns = opts.maxConnectionsPerKey ?? 32
  const rate = opts.rate ?? { burst: 60, perSecond: 20 }
  // Generous on purpose: a whole office can sit behind one NAT address.
  const connectRate = opts.connectRate ?? { burst: 200, perMinute: 1200 }
  let allowed: Set<string> | null = opts.allowKeys ? new Set(opts.allowKeys) : null
  const counters = { delivered: 0, rejected: 0 }

  const db = new Database(opts.dbPath ?? ':memory:', { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, sender TEXT NOT NULL DEFAULT \'\', env TEXT NOT NULL, ts INTEGER NOT NULL)')
  db.run('CREATE INDEX IF NOT EXISTS queue_recipient ON queue (recipient, ts)')
  try {
    db.run("ALTER TABLE queue ADD COLUMN sender TEXT NOT NULL DEFAULT ''")
  } catch {}
  db.run('CREATE INDEX IF NOT EXISTS queue_pair ON queue (recipient, sender)')
  db.run('CREATE TABLE IF NOT EXISTS devices (pub TEXT NOT NULL, device TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY (pub, device))')
  db.run('CREATE TABLE IF NOT EXISTS acked (id TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY (id, device))')
  db.run('CREATE TABLE IF NOT EXISTS dir (team TEXT NOT NULL, key TEXT NOT NULL, record TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (team, key))')

  const q = {
    insert: db.prepare('INSERT OR IGNORE INTO queue (id, recipient, sender, env, ts) VALUES (?, ?, ?, ?, ?)'),
    count: db.prepare('SELECT COUNT(*) AS n FROM queue WHERE recipient = ?'),
    countPair: db.prepare('SELECT COUNT(*) AS n FROM queue WHERE recipient = ? AND sender = ?'),
    has: db.prepare('SELECT 1 AS yes FROM queue WHERE id = ? AND recipient = ?'),
    dirAll: db.prepare("SELECT team, record FROM dir WHERE key LIKE 'admit:%' OR key LIKE 'revoke:%'"),
    dirCount: db.prepare('SELECT COUNT(*) AS n FROM dir WHERE team = ? AND key LIKE ?'),
    take: db.prepare('SELECT id, env FROM queue WHERE recipient = ? ORDER BY ts LIMIT 500'),
    del: db.prepare('DELETE FROM queue WHERE id = ?'),
    ack: db.prepare('DELETE FROM queue WHERE id = ? AND recipient = ?'),
    pending: db.prepare('SELECT id, env FROM queue WHERE recipient = ? AND id NOT IN (SELECT id FROM acked WHERE device = ?) ORDER BY ts'),
    seen: db.prepare('INSERT INTO devices (pub, device, seen) VALUES (?, ?, ?) ON CONFLICT (pub, device) DO UPDATE SET seen = excluded.seen'),
    devices: db.prepare('SELECT device FROM devices WHERE pub = ? AND seen > ?'),
    markAcked: db.prepare('INSERT OR IGNORE INTO acked (id, device) VALUES (?, ?)'),
    waitingOn: db.prepare('SELECT COUNT(*) AS n FROM devices WHERE pub = ? AND seen > ? AND device NOT IN (SELECT device FROM acked WHERE id = ?)'),
    dropAcked: db.prepare('DELETE FROM acked WHERE id = ?'),
    pruneDevices: db.prepare('DELETE FROM devices WHERE seen < ?'),
    pruneAcked: db.prepare('DELETE FROM acked WHERE id NOT IN (SELECT id FROM queue)'),
    prune: db.prepare('DELETE FROM queue WHERE ts < ?'),
    total: db.prepare('SELECT COUNT(*) AS n FROM queue'),
    dirGet: db.prepare('SELECT record FROM dir WHERE team = ?'),
    dirOne: db.prepare('SELECT record FROM dir WHERE team = ? AND key = ?'),
    dirPut: db.prepare('INSERT OR REPLACE INTO dir (team, key, record, ts) VALUES (?, ?, ?, ?)'),
  }

  const byKey = new Map<string, Set<ServerWebSocket<Conn>>>()
  // Admitted members per team, minus each team's own revocations.
  const admitted = new Map<string, Set<string>>()
  const admit = (key: string, team: string) => admitted.set(key, (admitted.get(key) ?? new Set()).add(team))
  const unadmit = (key: string, team: string) => {
    admitted.get(key)?.delete(team)
    if (!admitted.get(key)?.size) admitted.delete(key)
  }
  for (const row of q.dirAll.all() as Array<{ team: string; record: string }>) {
    const r = JSON.parse(row.record) as TeamRecord
    if (r.kind === 'admit') admit(r.a.member, row.team)
  }
  for (const row of q.dirAll.all() as Array<{ team: string; record: string }>) {
    const r = JSON.parse(row.record) as TeamRecord
    if (r.kind === 'revoke') unadmit(r.r.member, row.team)
  }
  const isMember = (pub: string) => !allowed || allowed.has(pub) || admitted.has(pub)

  const ipBuckets = new Map<string, { tokens: number; at: number }>()
  function allowConnect(ip: string): boolean {
    const now = Date.now()
    const b = ipBuckets.get(ip) ?? { tokens: connectRate.burst, at: now }
    b.tokens = Math.min(connectRate.burst, b.tokens + ((now - b.at) / 60_000) * connectRate.perMinute)
    b.at = now
    ipBuckets.set(ip, b)
    if (ipBuckets.size > 50_000) ipBuckets.clear()
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  const send = (ws: ServerWebSocket<Conn>, msg: unknown): void => void ws.send(JSON.stringify(msg))
  const res = (ws: ServerWebSocket<Conn>, rid: unknown, body: Record<string, unknown>): void => send(ws, { t: 'res', rid, ...body })

  function allow(c: Conn): boolean {
    const now = Date.now()
    c.tokens = Math.min(rate.burst, c.tokens + ((now - c.refill) / 1000) * rate.perSecond)
    c.refill = now
    if (c.tokens < 1) return false
    c.tokens -= 1
    return true
  }

  // Envelopes handed to a live socket but not yet confirmed. If every socket for
  // that key goes away first, they go back in the queue for the next connection.
  const inflight = new Map<string, Map<string, { raw: string; sender: string }>>()
  const MAX_INFLIGHT = 2000

  function flush(ws: ServerWebSocket<Conn>, pub: string) {
    if (ws.data.acks) {
      // Rows stay until every recent device of this key has acked; this device gets what it hasn't.
      for (const row of q.pending.all(pub, ws.data.device) as Array<{ id: string; env: string }>) ws.send(`{"t":"env","env":${row.env}}`)
      return
    }
    for (;;) {
      const rows = q.take.all(pub) as Array<{ id: string; env: string }>
      for (const row of rows) {
        ws.send(`{"t":"env","env":${row.env}}`)
        q.del.run(row.id)
      }
      if (rows.length < 500) return
    }
  }

  function checkRoom(env: Envelope) {
    if ((q.count.get(env.to) as { n: number }).n >= maxQueue) throw new Error('recipient queue is full')
    if ((q.countPair.get(env.to, env.from) as { n: number }).n >= maxPerSender) throw new Error('too many queued messages for this recipient from you')
    if ((q.total.get() as { n: number }).n >= maxTotal) throw new Error('relay queue is full')
  }

  // A device acked: drop the row once every device seen lately has it.
  function acked(pub: string, device: string, id: string) {
    if (!device) {
      q.ack.run(id, pub)
      return
    }
    q.markAcked.run(id, device)
    if ((q.waitingOn.get(pub, Date.now() - DEVICE_TTL_MS, id) as { n: number }).n === 0) {
      q.ack.run(id, pub)
      q.dropAcked.run(id)
    }
  }

  function route(from: ServerWebSocket<Conn>, env: Envelope): { delivered: number; queued: boolean } {
    if (!isMember(env.to)) throw new Error('recipient has no mailbox on this relay')
    const raw = JSON.stringify(env)
    let delivered = 0
    let tracked = false
    for (const peer of byKey.get(env.to) ?? []) {
      if (peer === from) continue
      peer.send(`{"t":"env","env":${raw}}`)
      delivered++
      tracked ||= peer.data.acks
    }
    if (delivered > 0) {
      counters.delivered++
      if (tracked) {
        const m = inflight.get(env.to) ?? new Map()
        if (m.size < MAX_INFLIGHT) m.set(env.id, { raw, sender: env.from })
        inflight.set(env.to, m)
      }
      // A message that waits also stays for this person's devices that aren't online.
      const online = new Set([...(byKey.get(env.to) ?? [])].map(w => w.data.device))
      const away = (q.devices.all(env.to, Date.now() - DEVICE_TTL_MS) as Array<{ device: string }>).some(d => !online.has(d.device))
      if (env.keep === true && away) {
        checkRoom(env)
        q.insert.run(env.id, env.to, env.from, raw, Date.now())
      }
      return { delivered, queued: false }
    }
    checkRoom(env)
    q.insert.run(env.id, env.to, env.from, raw, Date.now())
    return { delivered: 0, queued: true }
  }

  function dirPut(c: Conn, team: string, record: TeamRecord) {
    if (!c.member) throw new Error('team directory is for members of this relay')
    if (typeof team !== 'string' || team.length > 64 || !record || typeof record !== 'object') throw new Error('bad directory write')
    const cardRow = q.dirOne.get(team, 'card') as { record: string } | null
    const card = cardRow ? (JSON.parse(cardRow.record) as { card: TeamCard }).card : null
    if (record.kind === 'card') {
      if (card) throw new Error('team already exists')
      if (!verifyTeamCard(record.card) || record.card.teamId !== team) throw new Error('bad team card')
    } else if (!card) {
      throw new Error('unknown team')
    } else if (record.kind === 'member') {
      if (!verifyMembership(card, record.m)) throw new Error('bad membership')
      if (record.m.card.sign !== c.pub) throw new Error('you can only write your own membership')
      if (record.m.cap.exp < Date.now()) throw new Error('team invite expired')
      const members = (q.dirCount.get(team, 'member:%') as { n: number }).n
      const admits = (q.dirCount.get(team, 'admit:%') as { n: number }).n
      if (!q.dirOne.get(team, recordKey(record)) && (members >= (opts.maxTeamMembers ?? 2000) || members - admits >= (opts.maxPendingJoins ?? 200))) throw new Error('team directory is full')
    } else if (record.kind === 'admit') {
      if (!verifyAdmission(card, record.a)) throw new Error('bad admission')
    } else if (record.kind === 'policy') {
      if (!verifyTeamPolicy(card, record.p)) throw new Error('bad team policy')
      const prev = q.dirOne.get(team, 'policy') as { record: string } | null
      if (prev && (JSON.parse(prev.record) as { p: { at: number } }).p.at >= record.p.at) throw new Error('stale team policy')
      if (JSON.stringify(record).length > 16_000) throw new Error('team policy too large')
    } else if (record.kind === 'revoke') {
      if (!verifyRevocation(card, record.r)) throw new Error('bad revocation')
    } else {
      throw new Error('unknown record kind')
    }
    q.dirPut.run(team, recordKey(record), JSON.stringify(record), Date.now())
    if (record.kind === 'admit') admit(record.a.member, team)
    if (record.kind === 'revoke') unadmit(record.r.member, team)
  }

  const pruneTimer = setInterval(() => {
    q.prune.run(Date.now() - ttl)
    q.pruneDevices.run(Date.now() - DEVICE_TTL_MS)
    q.pruneAcked.run()
  }, 3600_000)

  const server = Bun.serve<Conn>({
    port: opts.port ?? 8787,
    hostname: opts.hostname ?? '127.0.0.1',
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/healthz') return Response.json({ ok: true, ...stats() })
      if (url.pathname === '/metrics') return new Response(metrics(), { headers: { 'content-type': 'text/plain; version=0.0.4' } })
      if (url.pathname === '/v1/ws') {
        const fwd = opts.trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined
        const ip = fwd || srv.requestIP(req)?.address || 'unknown'
        if (!allowConnect(ip)) {
          counters.rejected++
          return new Response('slow down', { status: 429 })
        }
        const ok = srv.upgrade(req, {
          data: { id: randomId(6), ip, host: (opts.publicHost ?? req.headers.get('host') ?? '').toLowerCase(), pub: null, member: false, acks: false, device: '', nonce: randomId(18), tokens: rate.burst, refill: Date.now() },
          headers: { 'Sec-WebSocket-Protocol': RELAY_PROTOCOL },
        })
        return ok ? undefined : new Response('websocket upgrade failed', { status: 400 })
      }
      return new Response('quietsync relay\n', { status: url.pathname === '/' ? 200 : 404 })
    },
    websocket: {
      maxPayloadLength: MAX_ENVELOPE_BYTES * 2,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        send(ws, { t: 'challenge', nonce: ws.data.nonce })
      },
      message(ws, data) {
        const c = ws.data
        let msg: any
        try {
          msg = JSON.parse(String(data))
        } catch {
          return send(ws, { t: 'err', error: 'bad json' })
        }
        if (!c.pub) {
          if (msg.t !== 'auth' || typeof msg.pub !== 'string' || typeof msg.sig !== 'string') return ws.close(4001, 'auth required')
          let ok = false
          try {
            ok = unb64u(msg.pub).length === 32 && verify(unb64u(msg.sig), relayAuthBytes(c.host, c.nonce), unb64u(msg.pub))
          } catch {}
          if (!ok) {
            counters.rejected++
            return ws.close(4003, 'bad auth')
          }
          c.pub = msg.pub
          c.acks = msg.ack === true
          c.device = typeof msg.device === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(msg.device) ? msg.device : ''
          c.member = isMember(msg.pub)
          send(ws, { t: 'ready', member: c.member })
          // Guests (members-only relays) can deliver but get no mailbox.
          if (!c.member) return
          const set = byKey.get(msg.pub) ?? new Set()
          if (set.size >= maxConns) return ws.close(4029, 'too many connections for this key')
          set.add(ws)
          byKey.set(msg.pub, set)
          if (c.acks && c.device) q.seen.run(msg.pub, c.device, Date.now())
          flush(ws, msg.pub)
          return
        }
        // Acks only remove the caller's own rows, and a big file means many of them, so they skip the rate limit.
        if (msg.t === 'ack') {
          const ids: unknown[] = Array.isArray(msg.ids) ? msg.ids.slice(0, 500) : []
          const m = inflight.get(c.pub)
          for (const id of ids) {
            if (typeof id !== 'string') continue
            if (!m?.has(id) && !q.has.get(id, c.pub)) continue
            acked(c.pub, c.device, id)
            m?.delete(id)
          }
          return
        }
        if (!allow(c)) return res(ws, msg.rid, { ok: false, error: 'rate limited' })
        try {
          if (msg.t === 'send') {
            const env = msg.env
            if (!isEnvelope(env) || env.from !== c.pub) throw new Error('bad envelope')
            if (JSON.stringify(env).length > MAX_ENVELOPE_BYTES) throw new Error('envelope too large')
            return res(ws, msg.rid, { ok: true, ...route(ws, env) })
          }
          if (msg.t === 'dir.put') {
            dirPut(c, msg.team, msg.record)
            return res(ws, msg.rid, { ok: true })
          }
          if (msg.t === 'dir.get') {
            if (!c.member) throw new Error('team directory is for members of this relay')
            const records = (q.dirGet.all(String(msg.team)) as Array<{ record: string }>).map(r => JSON.parse(r.record))
            return res(ws, msg.rid, { ok: true, records })
          }
          if (msg.t === 'ping') return res(ws, msg.rid, { ok: true })
          throw new Error(`unknown request ${msg.t}`)
        } catch (e) {
          res(ws, msg.rid, { ok: false, error: (e as Error).message })
        }
      },
      close(ws) {
        const pub = ws.data.pub
        if (!pub) return
        const set = byKey.get(pub)
        set?.delete(ws)
        if (set && set.size === 0) {
          byKey.delete(pub)
          const m = inflight.get(pub)
          inflight.delete(pub)
          for (const [id, e] of m ?? []) q.insert.run(id, pub, e.sender, e.raw, Date.now())
        }
      },
    },
  })

  function stats(): RelayStats {
    let connections = 0
    for (const s of byKey.values()) connections += s.size
    return { connections, keys: byKey.size, queued: (q.total.get() as { n: number }).n, ...counters }
  }

  function metrics(): string {
    const s = stats()
    return [
      '# TYPE quietsync_relay_connections gauge',
      `quietsync_relay_connections ${s.connections}`,
      '# TYPE quietsync_relay_keys gauge',
      `quietsync_relay_keys ${s.keys}`,
      '# TYPE quietsync_relay_queued gauge',
      `quietsync_relay_queued ${s.queued}`,
      '# TYPE quietsync_relay_delivered_total counter',
      `quietsync_relay_delivered_total ${s.delivered}`,
      '# TYPE quietsync_relay_rejected_total counter',
      `quietsync_relay_rejected_total ${s.rejected}`,
      '',
    ].join('\n')
  }

  const port = server.port!
  const host = opts.hostname ?? '127.0.0.1'
  log(`quietsync relay listening on ws://${host}:${port}/v1/ws`)
  return {
    url: `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/v1/ws`,
    port,
    stats,
    allow(keys) {
      allowed = new Set(keys)
    },
    stop() {
      clearInterval(pruneTimer)
      server.stop(true)
      db.close()
    },
  }
}
