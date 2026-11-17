import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { describeFindings, scanSecrets, type DlpOptions, type Finding } from './dlp.ts'
import { sanitizeLabel } from './sanitize.ts'

// Attachments. Everything here works on bytes in memory: nothing is ever
// extracted, executed or opened. Outgoing files are inspected so the human sees
// what leaves; incoming ones are only described.

// A chunk, base64'd inside a payload that's sealed and base64'd again, has to
// fit an envelope (256 KB).
export const CHUNK_BYTES = 96 * 1024
export const MAX_FILE_MB_LIMIT = 50

export type FileKind = 'text' | 'image' | 'zip' | 'pdf' | 'executable' | 'binary'
export type ZipEntry = { name: string; size: number; compressed: number; method: number; encrypted: boolean; symlink: boolean }
export type ZipInfo = { entries: ZipEntry[]; problems: string[]; totalSize: number }

const starts = (b: Uint8Array, ...bytes: number[]) => bytes.every((x, i) => b[i] === x)

// By content, never by name: a "photo.png" that's really a zip is a zip.
export function sniff(data: Uint8Array): { kind: FileKind; mime: string } {
  if (starts(data, 0x89, 0x50, 0x4e, 0x47)) return { kind: 'image', mime: 'image/png' }
  if (starts(data, 0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' }
  if (starts(data, 0x47, 0x49, 0x46, 0x38)) return { kind: 'image', mime: 'image/gif' }
  if (starts(data, 0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return { kind: 'image', mime: 'image/webp' }
  if (starts(data, 0x25, 0x50, 0x44, 0x46)) return { kind: 'pdf', mime: 'application/pdf' }
  if (starts(data, 0x50, 0x4b, 0x03, 0x04) || starts(data, 0x50, 0x4b, 0x05, 0x06)) return { kind: 'zip', mime: 'application/zip' }
  if (
    starts(data, 0x7f, 0x45, 0x4c, 0x46) ||
    starts(data, 0x4d, 0x5a) ||
    starts(data, 0xfe, 0xed, 0xfa, 0xce) ||
    starts(data, 0xfe, 0xed, 0xfa, 0xcf) ||
    starts(data, 0xcf, 0xfa, 0xed, 0xfe) ||
    starts(data, 0xce, 0xfa, 0xed, 0xfe) ||
    starts(data, 0xca, 0xfe, 0xba, 0xbe) ||
    starts(data, 0x23, 0x21)
  ) {
    return { kind: 'executable', mime: 'application/octet-stream' }
  }
  const head = data.subarray(0, 8192)
  if (!head.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head.length < data.length && head.length === 8192 ? trimUtf8(head) : head)
      return { kind: 'text', mime: 'text/plain' }
    } catch {}
  }
  return { kind: 'binary', mime: 'application/octet-stream' }
}

// Don't fail a valid UTF-8 file because the 8 KB sample cut a character in half.
function trimUtf8(b: Uint8Array): Uint8Array {
  let end = b.length
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const c = b[end - i]!
    if ((c & 0xc0) === 0xc0) return b.subarray(0, end - i)
    if ((c & 0x80) === 0) break
  }
  return b
}

// Removes metadata that can carry location, device and author details.
export function stripImageMetadata(data: Uint8Array, mime: string): { data: Uint8Array; removed: string[] } {
  if (mime === 'image/jpeg') return stripJpeg(data)
  if (mime === 'image/png') return stripPng(data)
  return { data, removed: [] }
}

function stripJpeg(data: Uint8Array): { data: Uint8Array; removed: string[] } {
  const keep: Uint8Array[] = [data.subarray(0, 2)]
  const removed = new Set<string>()
  let i = 2
  while (i + 4 <= data.length && data[i] === 0xff) {
    const marker = data[i + 1]!
    if (marker === 0xda) break // start of scan: the rest is image data
    const len = (data[i + 2]! << 8) | data[i + 3]!
    const seg = data.subarray(i, i + 2 + len)
    if (marker === 0xe1) removed.add('EXIF/XMP')
    else if (marker === 0xed) removed.add('IPTC')
    else if (marker === 0xfe) removed.add('comment')
    else if (marker >= 0xe2 && marker <= 0xef && marker !== 0xee) removed.add('app data')
    else keep.push(seg)
    i += 2 + len
  }
  keep.push(data.subarray(i))
  return { data: concatBytes(keep), removed: [...removed] }
}

function stripPng(data: Uint8Array): { data: Uint8Array; removed: string[] } {
  const keep: Uint8Array[] = [data.subarray(0, 8)]
  const removed = new Set<string>()
  const drop = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME'])
  let i = 8
  while (i + 12 <= data.length) {
    const len = ((data[i]! << 24) >>> 0) + (data[i + 1]! << 16) + (data[i + 2]! << 8) + data[i + 3]!
    const type = String.fromCharCode(...data.subarray(i + 4, i + 8))
    const end = i + 12 + len
    if (end > data.length) break
    if (drop.has(type)) removed.add(type === 'eXIf' ? 'EXIF' : 'text chunks')
    else keep.push(data.subarray(i, end))
    i = end
  }
  if (i < data.length) keep.push(data.subarray(i))
  return { data: concatBytes(keep), removed: [...removed] }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8)
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0

// Lists a zip from its central directory, flagging what makes archives
// dangerous to unpack. Never writes anything.
export function readZip(data: Uint8Array): ZipInfo {
  const problems = new Set<string>()
  const entries: ZipEntry[] = []
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (u32(data, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { entries, problems: ['not a readable zip'], totalSize: 0 }
  const count = u16(data, eocd + 10)
  let p = u32(data, eocd + 16)
  if (count === 0xffff || p === 0xffffffff) problems.add('zip64 archive (listed partly)')
  let totalSize = 0
  for (let n = 0; n < count && p + 46 <= data.length; n++) {
    if (u32(data, p) !== 0x02014b50) {
      problems.add('damaged directory')
      break
    }
    const flags = u16(data, p + 8)
    const method = u16(data, p + 10)
    const compressed = u32(data, p + 20)
    const size = u32(data, p + 24)
    const nameLen = u16(data, p + 28)
    const extraLen = u16(data, p + 30)
    const commentLen = u16(data, p + 32)
    const external = u32(data, p + 38)
    const name = new TextDecoder().decode(data.subarray(p + 46, p + 46 + nameLen))
    const symlink = ((external >>> 16) & 0o170000) === 0o120000
    const encrypted = (flags & 1) === 1
    entries.push({ name, size, compressed, method, encrypted, symlink })
    totalSize += size
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')) problems.add('entries that would write outside the folder (path traversal)')
    if (symlink) problems.add('symbolic links')
    if (encrypted) problems.add('encrypted entries the scanner can not read')
    if (/\.(zip|jar|tar|gz|tgz|7z|rar)$/i.test(name)) problems.add('archives inside the archive')
    if (/\.(exe|dll|so|dylib|sh|bat|cmd|ps1|app|command|scr|msi|pkg|dmg)$/i.test(name)) problems.add('executables')
    if (compressed > 0 && size / compressed > 200 && size > 10_000_000) problems.add('extreme compression (possible zip bomb)')
    p += 46 + nameLen + extraLen + commentLen
  }
  if (entries.length > 10_000) problems.add('more than 10,000 entries')
  if (totalSize > 1_000_000_000) problems.add('unpacks to more than 1 GB (possible zip bomb)')
  return { entries, problems: [...problems], totalSize }
}

// Small text entries, decompressed in memory, so the secret scanner can read them.
function zipTexts(data: Uint8Array, info: ZipInfo, budget = 4_000_000): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = []
  let p = 0
  let used = 0
  while (p + 30 <= data.length && used < budget) {
    if (u32(data, p) !== 0x04034b50) break
    const flags = u16(data, p + 6)
    const method = u16(data, p + 8)
    let compressed = u32(data, p + 18)
    const size = u32(data, p + 22)
    const nameLen = u16(data, p + 26)
    const extraLen = u16(data, p + 28)
    const name = new TextDecoder().decode(data.subarray(p + 30, p + 30 + nameLen))
    const start = p + 30 + nameLen + extraLen
    // Sizes may live in a data descriptor; take them from the directory then.
    if (flags & 8) compressed = info.entries.find(e => e.name === name)?.compressed ?? 0
    const body = data.subarray(start, start + compressed)
    const entry = info.entries.find(e => e.name === name)
    const realSize = entry?.size ?? size
    if (!(flags & 1) && realSize <= 1_000_000 && !name.endsWith('/')) {
      try {
        const raw = method === 0 ? body : method === 8 ? inflateRawSync(body, { maxOutputLength: 1_100_000 }) : null
        if (raw && sniff(raw).kind === 'text') {
          out.push({ name, text: new TextDecoder().decode(raw) })
          used += raw.length
        }
      } catch {}
    }
    p = start + compressed + (flags & 8 ? (u32(data, start + compressed) === 0x08074b50 ? 16 : 12) : 0)
  }
  return out
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

// A file name someone else chose, made safe to show and to save under.
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  const clean = sanitizeLabel(base, 120)
    .replace(/[^\p{L}\p{N} ._()+-]/gu, '_')
    .replace(/^\.+/, '_')
    .trim()
  return clean || 'file'
}

export type Inspection = {
  name: string
  kind: FileKind
  mime: string
  size: number
  sha256: string
  data: Uint8Array
  findings: Finding[]
  notes: string[]
  blocked: string | null
  zip?: ZipInfo
}

// What the human is shown before a file leaves, and the exact bytes that go.
export function inspectOutgoing(name: string, raw: Uint8Array, opts: { maxBytes: number; dlp?: DlpOptions; allowSecrets?: boolean }): Inspection {
  const notes: string[] = []
  const { kind, mime } = sniff(raw)
  let data = raw
  let findings: Finding[] = []
  let zip: ZipInfo | undefined
  if (raw.length > opts.maxBytes) {
    return { name, kind, mime, size: raw.length, sha256: sha256Hex(raw), data, findings, notes, blocked: `${formatSize(raw.length)} is over the ${formatSize(opts.maxBytes)} limit for files`, zip }
  }
  if (kind === 'image') {
    const s = stripImageMetadata(raw, mime)
    data = s.data
    if (s.removed.length) notes.push(`removed image metadata: ${s.removed.join(', ')}`)
    notes.push("images can show things the scanner can't read (screenshots of keys, names, dashboards); look at it before sending")
  } else if (kind === 'text') {
    findings = raw.length <= 2_000_000 ? scanSecrets(new TextDecoder().decode(raw), opts.dlp) : []
    if (raw.length > 2_000_000) notes.push('text over 2 MB is not scanned')
  } else if (kind === 'zip') {
    zip = readZip(raw)
    notes.push(`zip with ${zip.entries.length} entries, ${formatSize(zip.totalSize)} unpacked`)
    for (const p of zip.problems) notes.push(`zip contains ${p}`)
    findings = scanSecrets(zip.entries.map(e => e.name).join('\n'), opts.dlp)
    for (const t of zipTexts(raw, zip)) findings.push(...scanSecrets(t.text, opts.dlp).map(f => ({ ...f, kind: `${f.kind} in ${t.name}` })))
  } else if (kind === 'executable') {
    notes.push('this is a program or script; the other side will be warned not to run it')
  } else {
    notes.push(`${kind === 'pdf' ? 'PDF' : 'binary'} contents are not scanned`)
  }
  if (opts.allowSecrets) findings = findings.map(f => ({ ...f, severity: 'warn' as const }))
  const blocking = findings.filter(f => f.severity !== 'warn')
  const blocked = blocking.length ? `the file contains what look like secrets (${describeFindings(blocking)}). Files are never redacted; remove them or ask your human.` : null
  return { name, kind, mime, size: data.length, sha256: sha256Hex(data), data, findings, notes, blocked, zip }
}

// How a received file is described to the agent and the human. Names inside a
// zip are someone else's text, so they're sanitized and capped.
export function describeIncoming(meta: { name: string; kind: FileKind; size: number; sha256: string }, zip?: ZipInfo): string {
  const parts = [`${safeFileName(meta.name)} (${meta.kind}, ${formatSize(meta.size)}, sha256 ${meta.sha256.slice(0, 16)})`]
  if (zip) {
    const names = zip.entries.slice(0, 20).map(e => sanitizeLabel(e.name, 100))
    parts.push(`zip with ${zip.entries.length} entries: ${names.join(', ')}${zip.entries.length > 20 ? ', …' : ''}`)
    if (zip.problems.length) parts.push(`warning: it contains ${zip.problems.join('; ')}`)
  }
  if (meta.kind === 'executable') parts.push('warning: this is a program or script')
  return parts.join('. ')
}
