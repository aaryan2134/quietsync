import { relLabel, type Rel, type SessionView } from '@quietsync/core'

const RESET = '\x1b[0m'
const BG: Record<Rel, string> = {
  external: '\x1b[1;97;41m',
  team: '\x1b[1;30;43m',
  self: '\x1b[1;97;44m',
}

function worst(rels: Rel[]): Rel {
  return rels.includes('external') ? 'external' : rels.includes('team') ? 'team' : 'self'
}

// One line for Claude Code's status bar. Shows only to the human, never the model.
export function renderStatusline(v: SessionView, color = true): string {
  if (!v.identity) return ''
  const paint = (rel: Rel, s: string) => (color ? `${BG[rel]} ${s} ${RESET}` : `[${s}]`)
  const parts: string[] = []
  if (v.incoming.length) {
    const r = v.incoming[0]!
    parts.push(paint(r.peer.rel, `quietsync: ${r.peer.label} (${relLabel(r.peer.rel)}) wants to link: "${r.topic}"${v.incoming.length > 1 ? ` +${v.incoming.length - 1}` : ''}`))
  }
  if (v.links.length) {
    const rel = worst(v.links.map(l => l.peer.rel))
    const who = v.links.map(l => `${l.peer.label}${l.role !== 'peer' ? ` (${l.role})` : ''}${l.send === 'auto' ? ' AUTO-SEND' : ''}`).join(', ')
    parts.push(paint(rel, `LINKED ${who} · peer text is untrusted${v.tainted ? ' · peer-driven turn' : ''}`))
  }
  if (v.outgoing.length) parts.push(color ? `\x1b[2mquietsync: waiting on ${v.outgoing.map(o => o.peer.label).join(', ')}${RESET}` : '')
  if (v.pending && v.delivery === 'hooks') parts.push(`quietsync: ${v.pending} new, press enter to read`)
  if (v.paused) parts.push('quietsync: paused')
  if (!parts.length) return color ? `\x1b[2mquietsync ${v.relay.connected ? 'on' : 'offline'}${RESET}` : ''
  return parts.filter(Boolean).join(' ')
}
