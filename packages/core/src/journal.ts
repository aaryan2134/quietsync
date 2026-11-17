import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { b64u, unb64u, utf8 } from './bytes.ts'
import { boxKeyFromPriv, newBoxKey, open, seal } from './crypto.ts'

// A company's copy of what its people's agents sent and got, for retention,
// legal hold and eDiscovery. Each entry is sealed to a key only the company
// holds: the user's machine keeps it without being able to read it back, and
// the relay never sees it. Only the managed policy (or an env policy, for
// testing) turns it on, and peers are told their messages are kept.

export type JournalConfig = { key: string; dir?: string; url?: string }

// What goes in: everything that carries someone's words or a file across.
const KEPT = new Set(['message', 'note', 'file.sent', 'file.received', 'link.request', 'link.accept', 'link.accepted', 'link.close', 'link.closed', 'note.applied', 'note.continue', 'note.recorded', 'note.dismissed'])
const AAD = utf8('quietsync/v1/journal')

export function checkJournal(c: unknown): string | null {
  if (!c || typeof c !== 'object') return 'journal must be an object'
  const j = c as Record<string, unknown>
  try {
    if (typeof j.key !== 'string' || unb64u(j.key).length !== 32) return 'journal.key must be the public key from `quietsync journal keygen`'
  } catch {
    return 'journal.key must be the public key from `quietsync journal keygen`'
  }
  if (j.dir !== undefined && typeof j.dir !== 'string') return 'journal.dir must be a folder path'
  if (j.url !== undefined) {
    try {
      if (new URL(String(j.url)).protocol !== 'https:') return 'journal.url must be https'
    } catch {
      return 'journal.url is not a URL'
    }
  }
  return null
}

export function journalKeygen(): { publicKey: string; privateKey: string } {
  const k = newBoxKey()
  return { publicKey: b64u(k.pub), privateKey: b64u(k.priv) }
}

export class Journal {
  readonly dir: string

  constructor(
    private cfg: JournalConfig,
    private who: { name: string; device: string },
    home: string,
  ) {
    const d = cfg.dir ?? join(home, 'journal')
    this.dir = d.startsWith('~/') ? join(homedir(), d.slice(2)) : d
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  write(entry: Record<string, unknown>): void {
    if (!KEPT.has(String(entry.event))) return
    const plain = utf8(JSON.stringify({ ts: new Date().toISOString(), by: this.who, ...entry }))
    const line = JSON.stringify({ v: 1, at: Date.now(), ...seal(unb64u(this.cfg.key), plain, AAD) })
    appendFileSync(join(this.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), `${line}\n`, { mode: 0o600 })
    // The collector gets the same sealed line; the local file is the copy that never fails.
    if (this.cfg.url) {
      void fetch(this.cfg.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: line, signal: AbortSignal.timeout(10_000), redirect: 'error' }).catch(() => {})
    }
  }
}

// For the company, with its private key: every entry in a file or folder, in order.
export function readJournal(path: string, privateKey: string): Array<Record<string, unknown>> {
  const box = boxKeyFromPriv(unb64u(privateKey))
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .map(f => join(path, f))
    : [path]
  const out: Array<Record<string, unknown>> = []
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const e = JSON.parse(line) as { epk: string; n: string; ct: string }
      out.push(JSON.parse(new TextDecoder().decode(open(box, e, AAD))))
    }
  }
  return out
}
