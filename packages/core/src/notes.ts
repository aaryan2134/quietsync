import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prepareOutbound, type DlpOptions } from './dlp.ts'
import type { PeerView } from './policy.ts'
import { isSuspicious } from './sanitize.ts'

// Messages that wait for people who aren't online. Unlike links they aren't
// tied to a session: they're kept on disk, shared by every quietsync process of
// the user, until they're answered, dismissed or pruned.

export type NoteKind = 'ask' | 'note' | 'reply' | 'request'
// out: queued (relay holds it) → sent (handed to a live session) → delivered
// (their quietsync stored it) → seen (their human looked) → answered.
// in: new → seen → answered. declined, dismissed and expired end a thread.
export type NoteState = 'queued' | 'sent' | 'delivered' | 'seen' | 'answered' | 'declined' | 'expired' | 'new' | 'dismissed'

export type Note = {
  key: string
  id: string
  dir: 'in' | 'out'
  peerId: string
  kind: NoteKind
  subject: string
  text: string
  flags: string[]
  replyTo?: string
  ticket?: string
  ticketBy?: 'me' | 'them'
  at: number
  state: NoteState
  stateAt: number
  // out: the session that sent it; in: the sender's session as they shared it.
  session: { id: string; label: string; kept?: boolean }
  answer?: string
  continued?: boolean
  recorded?: string[]
  // out: sent without a dialog because the person's mode allowed it.
  auto?: boolean
  // in: handed to the agent on its own, by this session.
  applied?: string
}

// `fits`: the whole answer fits on the band, so the human can read all of it before Continue.
export type NoteView = Omit<Note, 'peerId' | 'answer'> & { peer: PeerView; answer?: { text: string; flags: string[]; at: number; key: string; fits: boolean } }

export const BAND_CHARS = 1200
export const BAND_LINES = 16

export function fitsBand(text: string): boolean {
  return text.length <= BAND_CHARS && text.split('\n').length <= BAND_LINES
}

export const QUEUE_TTL_MS = 7 * 24 * 3600 * 1000

// A session claims a question while its answer is in flight. A claim left by a
// process that died is free again after two minutes.
export function stalePending(answer: string, now = Date.now()): boolean {
  if (!answer.startsWith('pending:')) return false
  const at = Number(answer.split(':')[2])
  return !Number.isFinite(at) || now - at > 120_000
}
export const MAX_NEW_PER_PEER = 20
export const MAX_NEW_TOTAL = 200

// Questions and requests both wait for an answer.
export function answerable(kind: NoteKind): boolean {
  return kind === 'ask' || kind === 'request'
}

const RANK: Record<NoteState, number> = { queued: 0, sent: 1, delivered: 2, new: 2, seen: 3, answered: 4, declined: 5, dismissed: 5, expired: 5 }

// Receipts can arrive out of order or twice; a thread never moves backwards.
export function advance(n: Note, state: NoteState, now = Date.now()): boolean {
  if (RANK[state] <= RANK[n.state]) return false
  n.state = state
  n.stateAt = now
  return true
}

export function noteKey(dir: 'in' | 'out', peerId: string, id: string): string {
  return `${dir}:${peerId.slice(0, 16)}:${id}`
}

export function expire(notes: Record<string, Note>, now = Date.now()): boolean {
  let changed = false
  for (const n of Object.values(notes)) {
    if (n.dir === 'out' && (n.state === 'queued' || n.state === 'sent') && now - n.at > QUEUE_TTL_MS) changed = advance(n, 'expired', now) || changed
  }
  return changed
}

const OPEN: NoteState[] = ['new', 'queued', 'sent', 'delivered', 'seen']

export function prune(notes: Record<string, Note>, keepDays: number, now = Date.now()): Record<string, Note> {
  const keep = Math.max(7, keepDays) * 24 * 3600 * 1000
  const out: Record<string, Note> = {}
  for (const [k, n] of Object.entries(notes)) {
    const done = !OPEN.includes(n.state) && (n.dir === 'in' || !answerable(n.kind) || n.continued || n.state !== 'answered')
    if (done && now - n.stateAt > keep) continue
    if (!done && now - n.at > keep + QUEUE_TTL_MS) continue
    out[k] = n
  }
  return out
}

// What's waiting, said twice: names and counts for the agent, since people's own
// words stay out of its context until the human opens them, and subjects for the human.
export function waitingSummary(views: NoteView[], sessionLabel?: string): { keys: string[]; model: string | null; human: string | null } {
  const inbox = views.filter(v => v.dir === 'in' && v.kind !== 'reply' && v.state === 'new' && !v.applied)
  const answers = views.filter(v => v.dir === 'out' && answerable(v.kind) && v.state === 'answered' && !v.continued && (!sessionLabel || v.session.label === sessionLabel))
  if (!inbox.length && !answers.length) return { keys: [], model: null, human: null }
  const subject = (v: NoteView) => (isSuspicious(v.flags) ? '(subject withheld)' : `"${v.subject.replace(/\s+/g, ' ').slice(0, 60)}"`)
  const counts = new Map<string, number>()
  const what = (v: NoteView) => (v.kind === 'ask' ? 'question' : v.kind === 'request' ? 'request' : 'FYI')
  for (const v of inbox) counts.set(`${what(v)}|${v.peer.label}`, (counts.get(`${what(v)}|${v.peer.label}`) ?? 0) + 1)
  const parts = [...counts].map(([k, n]) => {
    const [w, who] = k.split('|')
    return `${n === 1 ? (w === 'FYI' ? 'an FYI' : `a ${w}`) : `${n} ${w}s`} from ${who}`
  })
  if (answers.length) parts.push(`${answers.length === 1 ? 'an answer' : `${answers.length} answers`} to ${sessionLabel ? 'what this project asked' : 'questions you asked'} (from ${[...new Set(answers.map(a => a.peer.label))].join(', ')})`)
  const model = `quietsync: waiting for your human: ${parts.join('; ')}. Tell them in one line at a natural pause. Don't open these yourself unless they ask. They can use the quietsync band, run \`quietsync messages\` in their own terminal, or ask you to read them with quietsync_messages, which runs at peer privilege.`
  const human = `quietsync: ${[...inbox.slice(0, 3).map(v => `${v.peer.label} ${v.kind === 'ask' ? 'asks' : v.kind === 'request' ? 'requests' : 'says'} ${subject(v)}`), ...answers.slice(0, 3).map(v => `${v.peer.label} answered ${subject(v)}`)].join('; ')}${inbox.length + answers.length > 6 ? '; and more' : ''}. Read with \`quietsync messages\`.`
  return { keys: [...inbox, ...answers].map(v => v.key), model, human }
}

// ---- records: copies of a thread in the tools people already keep -------------

export type RecordDest =
  | { type: 'slack'; url: string; auto?: boolean }
  | { type: 'webhook'; url: string; auto?: boolean }
  | { type: 'jira'; site: string; email: string; token: string; auto?: boolean }
  | { type: 'email'; to: string; auto?: boolean }
  | { type: 'file'; dir: string; auto?: boolean }

export const RECORD_TYPES = ['slack', 'webhook', 'jira', 'email', 'file'] as const

export type Thread = { subject: string; ticket?: string; ticketBy?: 'me' | 'them'; ask: { by: string; text: string; at: number }; answer?: { by: string; text: string; at: number } }

// Values may point at an environment variable instead of holding the secret.
function resolve(v: string): string {
  if (!v.startsWith('env:')) return v
  const got = process.env[v.slice(4)]
  if (!got) throw new Error(`environment variable ${v.slice(4)} is not set`)
  return got
}

export function checkDest(d: RecordDest): string | null {
  if (!RECORD_TYPES.includes(d.type)) return `unknown record type ${(d as { type: string }).type}`
  const https = (u: string) => {
    if (u.startsWith('env:')) return null
    try {
      return new URL(u).protocol === 'https:' ? null : 'must be an https:// URL'
    } catch {
      return 'not a URL'
    }
  }
  if (d.type === 'slack' || d.type === 'webhook') return https(d.url)
  if (d.type === 'jira') return https(d.site) ?? (d.email && d.token ? null : 'needs an email and an API token')
  if (d.type === 'email') return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(d.to) ? null : 'needs an email address'
  return d.dir ? null : 'needs a folder'
}

const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')

export function formatThread(t: Thread): string {
  return [
    `QuietSync thread: ${t.subject || '(no subject)'}${t.ticket ? ` [${t.ticket}]` : ''}`,
    '',
    `${t.ask.by} asked, ${day(t.ask.at)} UTC:`,
    t.ask.text,
    ...(t.answer ? ['', `${t.answer.by} answered, ${day(t.answer.at)} UTC:`, t.answer.text] : []),
  ].join('\n')
}

// Text from people goes into other tools' markup, so their control sequences
// (Slack mentions like <!channel>, Jira macros) are neutralised first.
function slackSafe(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function jiraSafe(s: string): string {
  return s.replace(/\{noformat\}/gi, '{ noformat }')
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'thread'
}

export type PostResult = { ok: true; detail: string } | { ok: false; detail: string }

export async function postRecord(name: string, d: RecordDest, t: Thread, dlp: DlpOptions, opts: { open?: (url: string) => void; fetchImpl?: typeof fetch } = {}): Promise<PostResult> {
  const problem = checkDest(d)
  if (problem) return { ok: false, detail: `${name}: ${problem}` }
  const text = formatThread(t)
  // Their answer was scanned on their side; this is ours, before it leaves for a third place.
  const o = prepareOutbound(text, { mode: 'block', allowSecrets: false, maxChars: 40_000, dlp })
  if (o.blocked) return { ok: false, detail: `${name}: not posted, ${o.blocked}` }
  const f = opts.fetchImpl ?? fetch
  const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
    // env: values are only known now, so the https rule is checked again.
    if (new URL(url).protocol !== 'https:') throw new Error('must be an https:// URL')
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  }
  try {
    switch (d.type) {
      case 'slack':
        await post(resolve(d.url), { text: slackSafe(o.text) })
        return { ok: true, detail: `${name}: posted to Slack` }
      case 'webhook':
        await post(resolve(d.url), { source: 'quietsync', subject: t.subject, ticket: t.ticket ?? null, ask: t.ask, answer: t.answer ?? null, text: o.text })
        return { ok: true, detail: `${name}: posted to the webhook` }
      case 'jira': {
        if (!t.ticket) return { ok: false, detail: `${name}: this thread has no ticket key to comment on` }
        const auth = Buffer.from(`${resolve(d.email)}:${resolve(d.token)}`).toString('base64')
        await post(`${resolve(d.site).replace(/\/$/, '')}/rest/api/2/issue/${encodeURIComponent(t.ticket)}/comment`, { body: `{noformat}${jiraSafe(o.text)}{noformat}` }, { authorization: `Basic ${auth}` })
        return { ok: true, detail: `${name}: commented on ${t.ticket}` }
      }
      case 'email': {
        const url = `mailto:${encodeURIComponent(d.to)}?subject=${encodeURIComponent(`QuietSync: ${t.subject}`)}&body=${encodeURIComponent(o.text)}`
        if (!opts.open) return { ok: false, detail: `${name}: can't open a mail draft here` }
        opts.open(url)
        return { ok: true, detail: `${name}: opened a mail draft to ${d.to}, send it from your mail app` }
      }
      case 'file': {
        const dir = d.dir.startsWith('~/') ? join(homedir(), d.dir.slice(2)) : d.dir
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        const file = join(dir, `${new Date(t.ask.at).toISOString().slice(0, 10)}-${slug(t.subject)}-${t.ask.at.toString(36)}.md`)
        writeFileSync(file, `${o.text}\n`, { mode: 0o600 })
        chmodSync(file, 0o600)
        return { ok: true, detail: `${name}: saved ${file}` }
      }
    }
  } catch (e) {
    return { ok: false, detail: `${name}: ${(e as Error).message}` }
  }
}
