import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { fingerprint } from './crypto.ts'
import { defaultHome, socketPathFor } from './paths.ts'
import { deserializeIdentity, serializeIdentity, type Identity, type IdentityCard, type StoredIdentity } from './identity.ts'
import type { Rel } from './policy.ts'
import type { PolicyFile } from './rules.ts'
import type { AuditLevel } from './profiles.ts'
import type { Membership, TeamCard, TeamPolicy } from './team.ts'
import type { Note, RecordDest } from './notes.ts'
import { systemKeyStore } from './keystore.ts'

export type Contact = {
  id: string
  name: string
  card: IdentityCard
  rel: Rel
  via: 'invite' | 'team' | 'device'
  teams: string[]
  handle?: string
  addedAt: number
  relay?: string
  verified?: boolean
  blocked?: boolean
  // Set by the human for the contact book: what they do, what to ask them about.
  role?: string
  note?: string
}

export type Config = { relay?: string; deviceName: string; deviceId?: string; linkIdleMinutes?: number; auditDays?: number }

export type StoredInvite = { kind: 'contact' | 'device'; secret: string; exp: number; createdAt: number; usedBy?: string }
export type PendingPair = { expected: string; relay: string; at: number }
export type StoredTeam = { card: TeamCard; adminKey?: string; handle: string; membership?: Membership; relay?: string; policy?: TeamPolicy; syncedAt?: number }

function staleLock(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, 'utf8'))
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true
      }
    }
    return Date.now() - statSync(file).mtimeMs > 10_000
  } catch {
    return false
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Plain JSON files under one directory, shared by every quietsync process of a
// user on a machine (CLI, one bridge per agent session). Writes are atomic and
// read-modify-write goes through a lock file.
export class Store {
  readonly home: string

  constructor(home = defaultHome()) {
    this.home = home
    mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 })
    mkdirSync(join(home, 'sessions'), { recursive: true, mode: 0o700 })
    mkdirSync(join(home, 'audit'), { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
  }

  path(...parts: string[]): string {
    return join(this.home, ...parts)
  }

  // Hooks ask on every tool call, so reads are cached against the file's mtime.
  private cache = new Map<string, { mtime: number; size: number; data: unknown }>()

  read<T>(name: string, fallback: T): T {
    const file = this.path(name)
    try {
      const st = statSync(file)
      const hit = this.cache.get(name)
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return structuredClone(hit.data) as T
      const data = JSON.parse(readFileSync(file, 'utf8')) as T
      this.cache.set(name, { mtime: st.mtimeMs, size: st.size, data })
      return structuredClone(data)
    } catch {
      return fallback
    }
  }

  write(name: string, data: unknown): void {
    this.cache.delete(name)
    const file = this.path(name)
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
  }

  // Holders keep the lock for one read and write, so waits are short. A lock left
  // by a process that died is taken over at once instead of after a timeout.
  private lock(name: string): () => void {
    const lockFile = this.path(`${name}.lock`)
    const deadline = Date.now() + 2000
    for (;;) {
      try {
        const fd = openSync(lockFile, 'wx')
        writeSync(fd, String(process.pid))
        closeSync(fd)
        return () => {
          try {
            unlinkSync(lockFile)
          } catch {}
        }
      } catch {
        if (staleLock(lockFile)) {
          // Only one process wins the rename, so two can't both take over.
          const gone = `${lockFile}.${process.pid}.stale`
          try {
            renameSync(lockFile, gone)
            unlinkSync(gone)
          } catch {}
          continue
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockFile}`)
        sleepSync(5)
      }
    }
  }

  update<T>(name: string, fallback: T, fn: (cur: T) => T | void): T {
    const release = this.lock(name)
    try {
      const cur = this.read(name, fallback)
      const next = fn(cur) ?? cur
      this.write(name, next)
      return next
    } finally {
      release()
    }
  }

  // A random id for this machine, kept in config, so the relay can tell devices apart.
  deviceId(): string {
    const c = this.config()
    if (c.deviceId && /^[A-Za-z0-9_-]{8,64}$/.test(c.deviceId)) return c.deviceId
    const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
    this.setConfig({ deviceId: id })
    return id
  }

  // identity.json holds the private keys, or says they're in the OS keychain.
  private idCache: { account: string; id: Identity } | null = null

  identity(): Identity | null {
    const s = this.read<(StoredIdentity & { keychain?: string }) | null>('identity.json', null)
    if (!s) return null
    if (s.keychain) {
      if (this.idCache?.account === s.keychain) return this.idCache.id
      const ks = systemKeyStore()
      const secret = ks?.get(s.keychain)
      if (!secret) throw new Error(`quietsync's keys are in the ${ks?.kind ?? 'OS keychain'} and couldn't be read. Unlock it, or run \`quietsync keys file\` on a machine where it works.`)
      const [sign, box] = secret.split('.')
      const id = deserializeIdentity({ ...s, sign: { pub: s.sign.pub, priv: sign! }, box: { pub: s.box.pub, priv: box! } })
      this.idCache = { account: s.keychain, id }
      return id
    }
    return deserializeIdentity(s)
  }

  keysInKeychain(): boolean {
    return !!this.read<{ keychain?: string } | null>('identity.json', null)?.keychain
  }

  requireIdentity(): Identity {
    const id = this.identity()
    if (!id) throw new Error('no quietsync identity yet, run `quietsync init --name <you> --relay <url>` first')
    return id
  }

  // `keychain: true` puts the private keys in the OS keychain and only the public half on disk.
  saveIdentity(id: Identity, opts: { keychain?: boolean } = {}): void {
    const s = serializeIdentity(id)
    this.idCache = null
    const old = this.read<{ keychain?: string } | null>('identity.json', null)?.keychain
    if (opts.keychain) {
      const ks = systemKeyStore()
      if (!ks) throw new Error('no OS keychain here (macOS keychain or Linux Secret Service)')
      const account = `${id.name}-${s.sign.pub.slice(0, 16)}`
      ks.set(account, `${s.sign.priv}.${s.box.priv}`)
      if (ks.get(account) !== `${s.sign.priv}.${s.box.priv}`) throw new Error(`wrote the keys to the ${ks.kind} but couldn't read them back`)
      this.write('identity.json', { ...s, sign: { pub: s.sign.pub, priv: '' }, box: { pub: s.box.pub, priv: '' }, keychain: account })
      if (old && old !== account) ks.del(old)
      return
    }
    this.write('identity.json', s)
    if (old) systemKeyStore()?.del(old)
  }

  config(): Config {
    return { deviceName: hostname().replace(/\.local$/, ''), ...this.read<Partial<Config>>('config.json', {}) }
  }

  setConfig(patch: Partial<Config>): Config {
    return this.update<Partial<Config>>('config.json', {}, c => ({ ...c, ...patch })) as Config
  }

  contacts(): Record<string, Contact> {
    return this.read('contacts.json', {})
  }

  updateContacts(fn: (c: Record<string, Contact>) => Record<string, Contact> | void): Record<string, Contact> {
    return this.update('contacts.json', {}, fn)
  }

  invites(): Record<string, StoredInvite> {
    return this.read('invites.json', {})
  }

  updateInvites(fn: (c: Record<string, StoredInvite>) => Record<string, StoredInvite> | void) {
    return this.update('invites.json', {}, fn)
  }

  pendingPairs(): Record<string, PendingPair> {
    return this.read('pending-pairs.json', {})
  }

  updatePendingPairs(fn: (c: Record<string, PendingPair>) => Record<string, PendingPair> | void) {
    return this.update('pending-pairs.json', {}, fn)
  }

  teams(): Record<string, StoredTeam> {
    return this.read('teams.json', {})
  }

  updateTeams(fn: (c: Record<string, StoredTeam>) => Record<string, StoredTeam> | void) {
    return this.update('teams.json', {}, fn)
  }

  // Keys that were rotated away, old to new, so a team directory that still
  // lists the old key doesn't bring it back.
  rotations(): Record<string, string> {
    return this.read<Record<string, string>>('rotations.json', {})
  }

  addRotation(oldId: string, newId: string): void {
    this.update<Record<string, string>>('rotations.json', {}, r => void (r[oldId] = newId))
  }

  notes(): Record<string, Note> {
    return this.read('notes.json', {})
  }

  updateNotes(fn: (n: Record<string, Note>) => Record<string, Note> | void): Record<string, Note> {
    return this.update('notes.json', {}, fn)
  }

  records(): Record<string, RecordDest> {
    return this.read('records.json', {})
  }

  updateRecords(fn: (r: Record<string, RecordDest>) => Record<string, RecordDest> | void): Record<string, RecordDest> {
    return this.update('records.json', {}, fn)
  }

  // Where files from other people land: outside quietsync's own folder so the
  // human can open it, but treated as peer content by the guards.
  inboxDir(): string {
    if (process.env.QUIETSYNC_INBOX) return process.env.QUIETSYNC_INBOX
    const configured = this.policyFile().inbox
    if (configured) return configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured
    return this.home === join(homedir(), '.quietsync') ? join(homedir(), 'quietsync-inbox') : `${this.home}-inbox`
  }

  policyFile(): PolicyFile {
    return this.read('policy.json', {})
  }

  updatePolicyFile(fn: (p: PolicyFile) => PolicyFile | void): PolicyFile {
    return this.update('policy.json', {}, fn)
  }

  // First session on this machine to claim a link wins; stops two sessions of
  // the same person accepting the same request, and replays from being re-accepted.
  claimLink(linkId: string, session: string): boolean {
    let won = false
    this.update<Record<string, { session: string; at: number }>>('claims.json', {}, all => {
      const now = Date.now()
      for (const [k, v] of Object.entries(all)) if (now - v.at > 8 * 86_400_000) delete all[k]
      if (all[linkId]) return
      all[linkId] = { session, at: now }
      won = true
    })
    return won
  }

  pruneAudit(days: number): void {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    for (const f of readdirSync(this.path('audit'))) if (f.endsWith('.jsonl') && f.slice(0, 10) < cutoff) rmSync(this.path('audit', f), { force: true })
  }

  // Set from the active profile: "metadata" drops message bodies and topics, "off" writes nothing.
  auditLevel: AuditLevel = 'full'

  // A company journal, when the managed policy sets one: it sees every entry in full, whatever the audit level.
  tee: ((entry: Record<string, unknown>) => void) | null = null

  audit(entry: Record<string, unknown>): void {
    try {
      this.tee?.(entry)
    } catch {}
    if (this.auditLevel === 'off') return
    if (this.auditLevel === 'metadata') {
      const { text: _t, topic: _p, target: _g, ...rest } = entry
      entry = { ...rest, ...(typeof _t === 'string' ? { chars: _t.length } : {}) }
    }
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(this.path('audit', `${day}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
  }

  socketPath(sessionId: string): string {
    return socketPathFor(this.home, sessionId)
  }

  sessionFile(sessionId: string): string {
    return this.path('sessions', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}.json`)
  }

  hasIdentity(): boolean {
    return existsSync(this.path('identity.json'))
  }
}

// Display name for a contact: team handle when known, plus a fingerprint stub
// when two contacts claim the same name.
export function contactLabel(c: Contact, all: Record<string, Contact>, teams: Record<string, StoredTeam>): string {
  const team = c.teams.map(t => teams[t]?.card.name).find(Boolean)
  const base = c.rel === 'team' && c.handle && team ? `${c.handle}@${team}` : c.name
  const clash = Object.values(all).some(o => o.id !== c.id && (o.name === c.name || plainLabel(o, teams) === base))
  return clash ? `${base}~${fingerprint(c.id).slice(0, 4)}` : base
}

function plainLabel(c: Contact, teams: Record<string, StoredTeam>): string {
  const team = c.teams.map(t => teams[t]?.card.name).find(Boolean)
  return c.rel === 'team' && c.handle && team ? `${c.handle}@${team}` : c.name
}
