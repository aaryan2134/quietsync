import { CONTROL, INVISIBLE } from './sanitize.ts'
import type { SecretMode } from './rules.ts'

// Outbound leak prevention. Everything an agent sends goes through
// prepareOutbound: invisible and control characters are stripped (so the
// approval dialog shows exactly what leaves), then it's scanned for credentials,
// this machine's own secret values and custom rules, then either blocked or
// redacted. "warn" findings don't stop a send but always put a human in front of it.

export type Severity = 'block' | 'warn' | 'evasion'
export type Finding = { kind: string; severity: Severity; preview: string; start: number; end: number }
export type Canary = { label: string; value: string }
export type DlpOptions = { canaries?: Canary[]; block?: RegExp[]; warn?: RegExp[]; terms?: string[] }

type Rule = { kind: string; re: RegExp; severity?: Severity; check?: (m: string) => boolean }

const RULES: Rule[] = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[^-]*-----|$)/g },
  { kind: 'aws access key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: 'aws secret key', re: /\baws_?secret_?access_?key\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/gi },
  { kind: 'gcp service account', re: /"private_key_id"\s*:\s*"[0-9a-f]{40}"/g },
  { kind: 'google oauth secret', re: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g },
  { kind: 'google api key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'github token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { kind: 'gitlab token', re: /\bgl(?:pat|ptt|dt|rt|soat|cbt)-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack token', re: /\bxox[abposre]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'slack webhook', re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g },
  { kind: 'discord webhook', re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g },
  { kind: 'anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'openai key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: 'stripe key', re: /\b(?:[rs]k_(?:live|test)_[0-9a-zA-Z]{20,}|whsec_[0-9a-zA-Z]{24,})\b/g },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'pypi token', re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/g },
  { kind: 'docker hub token', re: /\bdckr_pat_[A-Za-z0-9_-]{27,}\b/g },
  { kind: 'vault token', re: /\bhv[sbr]\.[A-Za-z0-9_-]{24,}\b/g },
  { kind: 'terraform token', re: /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{60,}\b/g },
  { kind: 'azure storage key', re: /\bAccountKey=[A-Za-z0-9+/]{86}==/g },
  { kind: 'azure sas token', re: /[?&]sig=[A-Za-z0-9%+/]{40,}={0,2}/g },
  { kind: 'twilio key', re: /\bSK[0-9a-f]{32}\b/g },
  { kind: 'sendgrid key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { kind: 'mailgun key', re: /\bkey-[0-9a-f]{32}\b/g },
  { kind: 'shopify token', re: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g },
  { kind: 'atlassian token', re: /\bATATT3[A-Za-z0-9_\-=]{100,}\b/g },
  { kind: 'linear key', re: /\blin_api_[A-Za-z0-9]{40}\b/g },
  { kind: 'notion token', re: /\b(?:secret_[A-Za-z0-9]{43}|ntn_[A-Za-z0-9]{40,})\b/g },
  { kind: 'figma token', re: /\bfig[dur]_[A-Za-z0-9_-]{40,}\b/g },
  { kind: 'hugging face token', re: /\bhf_[A-Za-z]{34}\b/g },
  { kind: 'databricks token', re: /\bdapi[0-9a-f]{32}(?:-\d)?\b/g },
  { kind: 'digitalocean token', re: /\bdo[pro]_v1_[0-9a-f]{64}\b/g },
  { kind: 'supabase token', re: /\bsbp_[0-9a-f]{40}\b/g },
  { kind: 'postman key', re: /\bPMAK-[0-9a-f]{24}-[0-9a-f]{34}\b/g },
  { kind: 'new relic key', re: /\bNRAK-[A-Z0-9]{27}\b/g },
  { kind: 'quietsync invite code', re: /\bqs1_[A-Za-z0-9_-]{40,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'auth header', re: /\bauthorization\s*:\s*(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { kind: 'url with password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@[^\s]+/gi },
  {
    kind: 'generic secret',
    re: /\b(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|passw(?:or)?d|pwd|access[_-]?key|auth[_-]?key|private[_-]?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=.!@#$%^&*]{12,}["']?/gi,
  },
  { kind: 'card number', re: /\b(?:\d[ -]?){13,19}\b/g, check: luhn },
  { kind: 'private address', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g, severity: 'warn' },
  { kind: 'ssn-like number', re: /\b\d{3}-\d{2}-\d{4}\b/g, severity: 'warn' },
]

function luhn(raw: string): boolean {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return sum % 10 === 0
}

function entropy(s: string): number {
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length)
  return h
}

// Long random-looking tokens. Hashes (git SHAs, sha256) and UUIDs are common
// in dev chat and not secrets, so they're skipped.
function highEntropy(text: string): Finding[] {
  const out: Finding[] = []
  for (const m of text.matchAll(/[A-Za-z0-9+/_\-=]{24,}/g)) {
    const t = m[0]
    if (/^[0-9a-f]+$/i.test(t) && (t.length === 40 || t.length === 64 || t.length < 32)) continue
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) continue
    if (/^[a-z_-]+$/i.test(t) || /^[\d_-]+$/.test(t) || t.includes('/') && /^[\w./-]+$/.test(t) && /[a-z]{4}/.test(t)) continue
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter(r => r.test(t)).length
    if (classes < 2) continue
    if (entropy(t) >= Math.min(4.5, Math.log2(t.length) - 0.35)) {
      out.push({ kind: 'random-looking token', severity: 'warn', preview: preview(t), start: m.index!, end: m.index! + t.length })
    }
  }
  return out
}

export function preview(match: string): string {
  const s = match.replace(/\s+/g, ' ')
  return s.length <= 10 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)}`
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '')
}

// A secret value can show up raw, URL-encoded, or base64'd at any byte offset.
// For base64 we take the middle of each of the three alignments.
function canaryForms(value: string): string[] {
  const forms = new Set([value, encodeURIComponent(value), Buffer.from(value, 'utf8').toString('hex'), [...value].reverse().join('')])
  const compact = value.replace(SEPARATORS, '')
  if (compact.length >= 8) forms.add(compact)
  if (value.length >= 12) {
    for (const pad of ['', 'x', 'xx']) {
      const enc = b64(pad + value)
      const start = Math.ceil((pad.length * 4) / 3) + 1
      const core = enc.slice(start, enc.length - 2)
      if (core.length >= 12) forms.add(core)
    }
  }
  return [...forms]
}

export function compileCanaries(canaries: Canary[]): Array<{ label: string; forms: string[] }> {
  return canaries.filter(c => c.value.length >= 8).map(c => ({ label: c.label, forms: canaryForms(c.value) }))
}

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSW|PASSPHRASE|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|DSN|CONN(ECTION)?_?STR|ACCESS)/i
const NOT_SECRET_ENV = /^(PWD|OLDPWD|PATH|HOME|SHELL|TERM|LANG|USER|LOGNAME|TMPDIR|SSH_AUTH_SOCK|.*_PATH|.*_DIR|.*_HOME|.*_URL|.*_HOST|.*_PORT|.*_ID|CLAUDE_CODE_SESSION_ID|QUIETSYNC_.*)$/

// Values of this process's environment that look like credentials. They're
// matched as exact strings, so a custom-format token still gets caught.
export function envCanaries(env: Record<string, string | undefined> = process.env): Canary[] {
  const out: Canary[] = []
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 8 || v.length > 4096) continue
    if (!SECRET_ENV_NAME.test(k) || NOT_SECRET_ENV.test(k)) continue
    if (/^(true|false|yes|no|on|off|\d+)$/i.test(v) || v.startsWith('/') || /^[a-z]+:\/\/[^@]*$/i.test(v)) continue
    out.push({ label: `$${k}`, value: v })
  }
  return out
}

type Compiled = { canaries: Array<{ label: string; forms: string[] }>; block: RegExp[]; warn: RegExp[]; terms: string[] }

const cache = new WeakMap<DlpOptions, Compiled>()

function compiled(opts: DlpOptions): Compiled {
  let c = cache.get(opts)
  if (!c) {
    const g = (r: RegExp) => (r.global ? r : new RegExp(r.source, `${r.flags}g`))
    c = {
      canaries: compileCanaries(opts.canaries ?? []),
      block: (opts.block ?? []).map(g),
      warn: (opts.warn ?? []).map(g),
      terms: (opts.terms ?? []).filter(Boolean).map(t => t.toLowerCase()),
    }
    cache.set(opts, c)
  }
  return c
}

// Letters from other scripts that look like Latin ones, and fullwidth ASCII.
// Folding keeps the length, so findings still point at the right characters.
const LOOKALIKE: Record<string, string> = Object.fromEntries(
  [
    ['АВЕКМНОРСТХУаеорсухіјѕԁԛԝ', 'ABEKMHOPCTXYaeopcyxijsdqw'],
    ['ΑΒΕΖΗΙΚΜΝΟΡΤΥΧαοριυνκ', 'ABEZHIKMNOPTYXaopiuvk'],
  ].flatMap(([from, to]) => [...from!].map((ch, i) => [ch, to![i]!])),
)

export function foldLookalikes(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0)
    else out += LOOKALIKE[ch] ?? ch
  }
  return out
}

const SEPARATORS = /[\s._\-|/\\·•,]+/g

// Other ways the same secret might be written. A hit in one of these is an
// attempt to get something past the scanner, so it blocks instead of redacting.
function evasionViews(text: string): string[] {
  const views: string[] = []
  const compact = text.replace(new RegExp(`(?<=[A-Za-z0-9])${SEPARATORS.source}(?=[A-Za-z0-9])`, 'g'), '')
  if (compact !== text) views.push(compact)
  views.push([...text].reverse().join(''))
  for (const m of text.matchAll(/\b(?:[0-9a-f]{2}){12,}\b/gi)) {
    try {
      const decoded = Buffer.from(m[0], 'hex').toString('utf8')
      if (/^[\x20-\x7e\s]+$/.test(decoded)) views.push(decoded)
    } catch {}
  }
  return views
}

export function scanSecrets(rawText: string, opts: DlpOptions = {}): Finding[] {
  const text = foldLookalikes(rawText)
  const found = scanPlain(text, opts)
  for (const view of evasionViews(text)) {
    const seen = new Set(found.filter(f => f.severity === 'block').map(f => f.kind))
    const hits = scanPlain(view, opts, true).filter(f => f.severity === 'block' && !seen.has(f.kind))
    if (hits.length) {
      found.push({ kind: `disguised ${hits[0]!.kind}`, severity: 'evasion', preview: hits[0]!.preview, start: 0, end: 0 })
      break
    }
  }
  // A random-looking token broken up with spaces or dashes: hold it for a human.
  const compact = evasionViews(text)[0]
  if (compact && compact !== text && !found.some(f => f.kind === 'random-looking token' || f.severity !== 'warn')) {
    const spread = highEntropy(compact).find(f => f.end - f.start >= 32)
    if (spread) found.push({ ...spread, kind: 'random-looking token (spaced out)', start: 0, end: 0 })
  }
  // Long hex runs that aren't the usual hash sizes might be an encoded key.
  for (const m of text.matchAll(/\b[0-9a-f]{32,}\b/gi)) {
    if ([40, 64].includes(m[0].length) || found.some(f => f.start <= m.index! && f.end >= m.index! + m[0].length)) continue
    found.push({ kind: 'long hex string', severity: 'warn', preview: preview(m[0]), start: m.index!, end: m.index! + m[0].length })
  }
  return dedupe(found)
}

// Formats distinctive enough to look for in rearranged text without flagging prose.
const LOOSE = new Set(['generic secret', 'card number', 'private address', 'ssn-like number', 'url with password', 'auth header', 'azure sas token', 'mailgun key', 'twilio key'])

function scanPlain(text: string, opts: DlpOptions, quick = false): Finding[] {
  const c = compiled(opts)
  const out: Finding[] = []
  const add = (kind: string, severity: Severity, start: number, match: string, show = true) =>
    out.push({ kind, severity, preview: show ? preview(match) : '****', start, end: start + match.length })

  for (const r of RULES) {
    if (quick && LOOSE.has(r.kind)) continue
    // In rearranged text a token can run into the word before it.
    const re = quick ? new RegExp(r.re.source.replace(/^\\b/, ''), r.re.flags) : r.re
    for (const m of text.matchAll(re)) {
      if (r.check && !r.check(m[0])) continue
      add(r.kind, r.severity ?? 'block', m.index!, m[0])
    }
  }
  for (const can of c.canaries) {
    for (const f of can.forms) {
      let i = text.indexOf(f)
      while (i >= 0) {
        add(`value of ${can.label}`, 'block', i, f, false)
        i = text.indexOf(f, i + 1)
      }
    }
  }
  for (const re of c.block) for (const m of text.matchAll(re)) add('custom rule', 'block', m.index!, m[0])
  for (const re of c.warn) for (const m of text.matchAll(re)) add('custom rule', 'warn', m.index!, m[0])
  if (c.terms.length) {
    const lower = text.toLowerCase()
    for (const t of c.terms) {
      let i = lower.indexOf(t)
      while (i >= 0) {
        add(`flagged term "${t}"`, 'warn', i, text.slice(i, i + t.length), false)
        i = lower.indexOf(t, i + 1)
      }
    }
  }
  if (quick) return out
  // Base64 blobs get decoded and scanned once, so encoding a key doesn't hide it.
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    let decoded = ''
    try {
      decoded = Buffer.from(m[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    } catch {
      continue
    }
    if (!/^[\x20-\x7e\s]{12,}$/.test(decoded)) continue
    const inner = RULES.some(r => r.severity !== 'warn' && !r.check && new RegExp(r.re.source, r.re.flags.replace('g', '')).test(decoded))
      || c.canaries.some(can => can.forms.some(f => decoded.includes(f)))
    if (inner) add('encoded secret', 'block', m.index!, m[0])
  }
  const covered = (f: { start: number; end: number }) => out.some(o => o.severity === 'block' && o.start <= f.start && o.end >= f.end)
  for (const f of highEntropy(text)) if (!covered(f)) out.push(f)
  return out
}

function dedupe(fs: Finding[]): Finding[] {
  const sorted = fs.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Finding[] = []
  for (const f of sorted) {
    const prev = out.find(o => o.start <= f.start && o.end >= f.end && (o.severity === 'block' || f.severity === 'warn'))
    if (!prev) out.push(f)
  }
  return out
}

export function redact(text: string, findings: Finding[]): string {
  const spans = findings.filter(f => f.severity === 'block').sort((a, b) => b.start - a.start)
  let out = text
  let lastStart = Infinity
  for (const f of spans) {
    if (f.end > lastStart) continue
    out = `${out.slice(0, f.start)}[redacted ${f.kind}]${out.slice(f.end)}`
    lastStart = f.start
  }
  return out
}

export type Outbound = {
  text: string
  findings: Finding[]
  redacted: number
  blocked: string | null
  hiddenRemoved: number
}

export function cleanOutbound(raw: string): { text: string; removed: number } {
  let removed = 0
  const text = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, () => (removed++, ''))
    .replace(CONTROL, m => (m === '\t' ? m : (removed++, '')))
    .trim()
  return { text, removed }
}

export function prepareOutbound(raw: string, opts: { mode: SecretMode; allowSecrets?: boolean; maxChars: number; dlp?: DlpOptions }): Outbound {
  const { text: clean, removed } = cleanOutbound(raw)
  if (!clean) return { text: '', findings: [], redacted: 0, blocked: 'empty message', hiddenRemoved: removed }
  if (clean.length > opts.maxChars) {
    return { text: clean, findings: [], redacted: 0, blocked: `too long (${clean.length} chars, limit ${opts.maxChars}). Shorten it or split it.`, hiddenRemoved: removed }
  }
  let findings = scanSecrets(clean, opts.dlp)
  if (removed) findings.push({ kind: 'hidden characters removed', severity: 'warn', preview: `${removed}`, start: 0, end: 0 })
  const evasion = findings.find(f => f.severity === 'evasion')
  if (evasion) {
    return { text: clean, findings, redacted: 0, blocked: `looks like a secret written to get past the scanner (${evasion.kind}). Not sent.`, hiddenRemoved: removed }
  }
  if (opts.allowSecrets) findings = findings.map(f => ({ ...f, severity: 'warn' as const }))
  const blocking = findings.filter(f => f.severity === 'block')
  if (!blocking.length) return { text: clean, findings, redacted: 0, blocked: null, hiddenRemoved: removed }
  if (opts.mode === 'redact') return { text: redact(clean, blocking), findings, redacted: blocking.length, blocked: null, hiddenRemoved: removed }
  return {
    text: clean,
    findings,
    redacted: 0,
    blocked: `looks like it contains secrets (${blocking.map(f => (f.preview !== '****' ? `${f.kind}: ${f.preview}` : f.kind)).join(', ')}). Remove them; only your human can allow secrets on a link.`,
    hiddenRemoved: removed,
  }
}

export function describeFindings(fs: Finding[]): string {
  const counts = new Map<string, number>()
  for (const f of fs) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
  return [...counts].map(([k, n]) => (n > 1 ? `${n}× ${k}` : k)).join(', ')
}
