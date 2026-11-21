import type { Mode, MsgKind } from './levels.ts'
import { describeFindings, type Finding, type Outbound } from './dlp.ts'
import { formatSize, type Inspection } from './files.ts'
import { absPath, checkShell, searchTargets, sensitivePattern, SHELL_TOOLS, shortPath, toolPaths, WRITE_TOOLS, type PathGuard } from './guard.ts'
import { TICKET_RE, type LinkCaps, type SessionInfo } from './messages.ts'
import type { NoteView } from './notes.ts'
import { isProfile, PROFILES } from './profiles.ts'
import { isSuspicious } from './sanitize.ts'
import { ROLE_HELP, type Approval, type Caps, type Isolation, type Policy, type Role, type SecretMode } from './rules.ts'

export type Rel = 'self' | 'team' | 'external'
export type SendPolicy = Approval

export type PeerView = { id: string; name: string; rel: Rel; fingerprint: string; label: string }

export type GroupView = { id: string; size: number }

export type LinkView = {
  id: string
  peer: PeerView
  peerSession: SessionInfo
  topic: string
  topicFlags: string[]
  direction: 'in' | 'out'
  group?: GroupView
  caps: Caps
  peerCaps: LinkCaps
  role: Role
  mode?: Mode
  send: SendPolicy
  allowSecrets: boolean
  isolation: Isolation
  secrets: SecretMode
  autoSendLimit: number
  autoStreak: number
  createdAt: number
  lastActivity: number
  sent: number
  received: number
  acked: number
}

export type RequestView = {
  id: string
  peer: PeerView
  session: SessionInfo
  topic: string
  topicFlags: string[]
  message?: string
  flags: string[]
  group?: GroupView
  peerCaps: LinkCaps
  at: number
}

export type OutgoingView = { id: string; peer: PeerView; topic: string; group?: GroupView; at: number }

export type SessionView = {
  session: SessionInfo
  identity: { name: string; fingerprint: string } | null
  relay: { url: string | null; connected: boolean }
  links: LinkView[]
  incoming: RequestView[]
  outgoing: OutgoingView[]
  // `ids` holds every peer whose words entered this turn; `by` is the latest, for display.
  tainted: { by: string; linkId: string; at: number; isolation?: Isolation; ids?: string[] } | null
  // Someone else's message entered this session's context; gating stays on as if a link were open.
  exposure?: { by: string; isolation: Isolation; at: number } | null
  isolation: Isolation | null
  paused: boolean
  mode: Role | null
  maxLinks: number
  policyChanged: boolean
  profile: ProfileView
  delivery: 'mod' | 'channel' | 'hooks'
  pending: number
  kept?: boolean
}

export type ProfileView = { name: string; org: string | null; orgOnly: boolean; external: boolean; requireVerified: boolean; autoSend: boolean; autoAccept: boolean; files: boolean; messages: boolean; records: boolean }

// `peerContent`: the call brings a received file's contents into this session.
// `fileSha`: the fingerprint of the exact file the human is approving.
type DecisionExtra = { peerContent?: string; fileSha?: string; recordSha?: string }
export type Decision =
  | ({ decision: 'allow'; reason?: string } & DecisionExtra)
  | ({ decision: 'ask'; reason: string } & DecisionExtra)
  | ({ decision: 'deny'; reason: string } & DecisionExtra)
  | ({ decision: 'none' } & DecisionExtra)

// Tools that only read local state or talk to the human. Everything else needs a
// human yes while a peer message is driving the turn.
export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'TodoRead',
  'AskUserQuestion',
  'ToolSearch',
  'ListMcpResourcesTool',
  'TaskList',
  'TaskGet',
])

const QUIETSYNC_TOOL = /^mcp__(?:plugin_quietsync_)?quietsync__quietsync_(\w+)$/

export function quietsyncTool(toolName: string): string | null {
  return QUIETSYNC_TOOL.exec(toolName)?.[1] ?? null
}

export function relLabel(rel: Rel): string {
  return rel === 'self' ? 'your other session' : rel === 'team' ? 'teammate' : 'external'
}

export function who(p: PeerView): string {
  return `${p.label} (${relLabel(p.rel)}, key ${p.fingerprint.slice(0, 9)})`
}

function str(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key]
  return typeof v === 'string' ? v : ''
}

function list(input: unknown, key: string): string[] {
  const v = (input as Record<string, unknown> | null)?.[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export type GateContext = {
  cwd: string
  home: string
  paths: PathGuard
  touches?: string[]
  // Something sensitive was read since the human last typed.
  sensitiveSeen?: boolean
  // Messages that went to this person without a dialog in the last hour.
  autoSent?: (peerId: string) => number
  lookup: (ref: string) => { peer: PeerView; policy: Policy } | null
  outbound: (targets: Array<{ linkId?: string; peerId?: string }>, text: string) => Outbound
  describeCode?: (code: string) => string
  checkCode?: (code: string) => string | null
  inspectFile?: (linkId: string, path: string) => Inspection
  note?: (ref: string) => NoteView | null
  record?: (ref: string, dest: string) => { type: string; text: string; sha: string; ticket?: string; ticketBy?: 'me' | 'them' } | string
}

const allow = (reason?: string): Decision => ({ decision: 'allow', reason })

export function messageKind(input: unknown): MsgKind {
  const i = (input ?? {}) as Record<string, unknown>
  if (i.type === 'request' || i.request === true) return 'request'
  if (i.type === 'fyi' || i.needs_reply === false) return 'fyi'
  return 'ask'
}
const ask = (reason: string): Decision => ({ decision: 'ask', reason })
const deny = (reason: string): Decision => ({ decision: 'deny', reason })
const NONE: Decision = { decision: 'none' }

function findingLines(o: Outbound): string[] {
  const out: string[] = []
  const red = o.findings.filter(f => f.severity === 'block')
  const warn = o.findings.filter(f => f.severity === 'warn')
  if (o.redacted) out.push(`! redacted before sending: ${describeFindings(red)}`)
  else if (red.length) out.push(`! SECRETS ALLOWED ON THIS LINK, these go out as-is: ${describeFindings(red)}`)
  if (warn.length) out.push(`! check before approving: ${warn.map((f: Finding) => (f.preview && f.preview !== '****' ? `${f.kind} (${f.preview})` : f.kind)).join(', ')}`)
  return out
}

function shownSubject(n: NoteView): string {
  return isSuspicious(n.flags) ? '(subject withheld: it tripped the injection checks)' : `"${n.subject}"`
}

function body(label: string, text: string): string {
  const lines = text.split('\n').length
  return `${label} (${text.length} chars${lines > 1 ? `, ${lines} lines` : ''}):\n${text}`
}

export function decideToolUse(view: SessionView, toolName: string, input: unknown, ctx: GateContext): Decision {
  const short = quietsyncTool(toolName)
  if (short) return decideQuietSync(view, short, input, ctx)
  return decideTool(view, toolName, input, ctx)
}

function decideTool(view: SessionView, toolName: string, input: unknown, ctx: GateContext): Decision {
  const tainted = !!view.tainted
  const linked = view.links.length > 0 || !!view.exposure
  const iso = view.isolation ?? 'standard'
  const by = view.tainted?.by ?? 'a peer'

  if (SHELL_TOOLS.has(toolName)) {
    const cmd = str(input, 'command').replace(/["'\\]/g, '')
    const s = checkShell(cmd, ctx.home, ctx.paths.inbox)
    if (s.control) return deny('quietsync controls are human-only. Ask your human to use the quietsync band or their own terminal.')
    if (s.quietsyncFiles) return deny("quietsync's files and control socket are off limits to the agent.")
    if (s.agentConfig && tainted) return deny(`a message from ${by} is driving this turn, and this command touches the agent's own settings or plugins. Not allowed while a peer is involved.`)
    if (s.agentConfig && linked) return ask("quietsync: a link is open and this command touches the agent's own settings or plugins, which hold the hooks that keep peers in check. Run it?")
    if (s.pty) return ask('quietsync: this runs a command in a fake terminal, which can get around checks that want a person at the keyboard. Run it?')
    if (s.peerContent) {
      return {
        ...ask("quietsync: this command works on files someone else sent you. They're untrusted: don't run, unpack or install them unless you mean to, and anything they print counts as the sender's text. Run it?"),
        peerContent: ctx.paths.inbox ?? 'quietsync-inbox',
      }
    }
    if (s.sensitive && tainted) return deny(`a message from ${by} is driving this turn, and this command touches ${s.sensitive}. Not allowed while a peer is involved.`)
    if (s.sensitive && linked) return ask(`quietsync: a link is open and this command touches ${s.sensitive}. Anything it prints could end up in a reply. Run it?`)
    if (tainted && (iso !== 'relaxed' || s.egress)) return ask(`quietsync, peer turn (restricted): words from ${by} are in this turn. Approve only if you want this to happen.`)
    if (linked && (iso === 'strict' || s.egress)) return ask(`quietsync: a link is open${iso === 'strict' ? ' (strict isolation)' : ''} and this command can send data off your machine. Run it?`)
    return NONE
  }

  let peerContent: string | undefined
  for (const p of toolPaths(toolName, input)) {
    const cls = ctx.paths.classify(p, ctx.cwd)
    if (cls === 'peer-content') {
      if (WRITE_TOOLS.has(toolName)) return { ...ask("quietsync: this changes a file someone else sent you. Allow?"), peerContent: p }
      peerContent = p
      continue
    }
    if (cls === 'quietsync-secret') return deny("quietsync's keys and invites are off limits to the agent.")
    if (cls === 'quietsync-config' && WRITE_TOOLS.has(toolName)) return deny('quietsync settings are human-only. Use `quietsync policy` in your own terminal or the band.')
    if (cls === 'agent-config' && WRITE_TOOLS.has(toolName) && tainted) return deny(`a message from ${by} is driving this turn, and ${shortPath(p, ctx.cwd)} holds the agent's settings or hooks. Not allowed while a peer is involved.`)
    if (cls === 'agent-config' && WRITE_TOOLS.has(toolName) && linked) return ask(`quietsync: a link is open and this changes ${shortPath(p, ctx.cwd)}, which holds the hooks that keep peers in check. Allow?`)
    if (cls === 'sensitive' && tainted) return deny(`a message from ${by} is driving this turn and ${shortPath(p, ctx.cwd)} looks sensitive. Not allowed while a peer is involved.`)
    if (cls === 'sensitive' && linked) return ask(`quietsync: a link is open and ${shortPath(p, ctx.cwd)} looks sensitive. Anything read here could end up in a reply. Allow?`)
  }

  // Searches can't be judged file by file: look at where they start and what they match.
  const search = searchTargets(toolName, input)
  if (search) {
    const own = ctx.paths.classify(search.root, ctx.cwd)
    if (own === 'quietsync-secret') return deny("quietsync's own folder is off limits to the agent.")
    const reached = ctx.paths.reaches(search.root, ctx.cwd)
    if (ctx.paths.reachesInbox(search.root, ctx.cwd)) peerContent = search.root
    const reach = reached === 'peer-content' ? null : reached
    const named = sensitivePattern(search.pattern)
    if ((reach || named) && tainted) return deny(`a message from ${by} is driving this turn, and this search ${named ? 'targets' : 'reaches'} protected files. Not allowed while a peer is involved.`)
    if ((reach || named) && linked) return { ...ask(`quietsync: a link is open and this search ${named ? 'targets' : 'reaches'} protected files. Anything found could end up in a reply. Allow?`), ...(peerContent ? { peerContent } : {}) }
    if (tainted && iso !== 'relaxed' && !insideDir(search.root, ctx.cwd)) {
      return ask(`quietsync, peer turn (restricted): a message from ${by} is driving this turn and this searches outside the project. Allow?`)
    }
    if (tainted) return ask(`quietsync, peer turn (restricted): words from ${by} are in this turn, and search results can include protected files even when the pattern looks safe. Allow this search?`)
  }

  const outside = toolPaths(toolName, input).some(p => !insideDir(p, ctx.cwd))
  const done = (d: Decision): Decision => (peerContent ? { ...d, peerContent } : d)
  if (tainted) {
    if (READ_ONLY_TOOLS.has(toolName)) {
      return done(iso === 'strict' && outside ? ask(`quietsync, peer turn (restricted): a message from ${by} is driving this turn and this reads outside the project. Allow?`) : NONE)
    }
    if (iso === 'relaxed' && !egressTool(toolName)) return done(NONE)
    return done(ask(`quietsync, peer turn (restricted): words from ${by} are in this turn. Approve only if you want this to happen.`))
  }
  if (linked) {
    if (iso === 'strict' && !READ_ONLY_TOOLS.has(toolName)) return done(ask('quietsync: a link is open with strict isolation, so tools other than reading files ask first.'))
    if (iso !== 'relaxed' && egressTool(toolName)) return done(ask('quietsync: a link is open and this can send data off your machine. Allow?'))
  }
  return done(NONE)
}

function egressTool(t: string): boolean {
  return t === 'WebFetch' || (t.startsWith('mcp__') && !quietsyncTool(t))
}

function insideDir(p: string, dir: string): boolean {
  const abs = absPath(p, dir)
  const d = absPath(dir).replace(/\/$/, '')
  return abs === d || abs.startsWith(`${d}/`)
}

// True when words from anyone other than these peers entered this turn. A source
// quietsync couldn't tie to a key never matches, so it always holds.
function othersInTurn(view: SessionView, ids: string[]): boolean {
  if (!view.tainted) return false
  return (view.tainted.ids ?? [`?${view.tainted.by}`]).some(id => !ids.includes(id))
}

function inTurnLine(view: SessionView): string[] {
  return view.tainted ? [`! words from ${view.tainted.by} are in this turn: check this is what you want to send`] : []
}

// Why an automatic send needs a person after all, or null when its content can go.
function holdContent(o: Outbound, view: SessionView, peers: PeerView[], ctx: GateContext): string | null {
  if (o.findings.length) return 'the scanner flagged something'
  if (othersInTurn(view, peers.map(p => p.id))) return 'words from someone else are in this turn'
  if (ctx.sensitiveSeen) return 'your agent read a sensitive file since you last typed'
  const code = (o.text.match(/```[\s\S]*?```/g) ?? []).reduce((n, b) => n + b.split('\n').length, 0)
  if (code > 40) return 'it carries a lot of code'
  if (o.text.length > 4000) return "it's long"
  return null
}

// Why a send that could go on its own needs a person after all, or null when it can go.
function holdAuto(o: Outbound, view: SessionView, peer: PeerView, policy: Policy, ctx: GateContext): string | null {
  const held = holdContent(o, view, [peer], ctx)
  if (held) return held
  const sent = ctx.autoSent?.(peer.id) ?? 0
  if (sent >= policy.autoSendLimit) return `${sent} messages to ${peer.label} already went without asking in the last hour`
  return null
}

const KIND_LABEL: Record<MsgKind, string> = { fyi: 'an FYI', ask: 'a question', answer: 'an answer', request: 'a request' }

function flowLine(policy: Policy, kind: MsgKind, held: string | null): string {
  if (policy.flow.out[kind] === 'auto') return `${policy.mode} mode would send this on its own, but held it: ${held}`
  return policy.mode === 'ask' || policy.mode === 'review' ? `you approve every send (mode ${policy.mode})` : `${KIND_LABEL[kind]} needs your OK (mode ${policy.mode}${policy.maxMode !== 'trusted' ? `, up to ${policy.maxMode}` : ''})`
}

function decideQuietSync(view: SessionView, short: string, input: unknown, ctx: GateContext): Decision {
  switch (short) {
    case 'connect': {
      const refs = [...new Set([...list(input, 'peers'), str(input, 'peer')].map(s => s.trim()).filter(Boolean))]
      if (!refs.length) return deny('name at least one peer')
      if (refs.length > 20) return deny('a group link can have at most 20 people')
      const found = refs.map(r => ({ ref: r, hit: ctx.lookup(r) }))
      const missing = found.filter(f => !f.hit).map(f => f.ref)
      if (missing.length) return deny(`no contact called ${missing.map(m => `"${m}"`).join(', ')}. Check quietsync_status for names.`)
      const peers = found.map(f => f.hit!)
      for (const { peer, policy } of peers) {
        if (policy.blockedBy) return deny(policy.blockedBy)
        if (!policy.caps.initiate) return deny(`your policy for ${peer.label} is "${policy.role}" (${ROLE_HELP[policy.role]}), so this session doesn't start links with them.`)
      }
      const open = view.links.length + view.outgoing.length
      if (open + peers.length > view.maxLinks) return deny(`this session already has ${open} links or requests (limit ${view.maxLinks}). Close some first.`)
      const targets = peers.map(p => ({ peerId: p.peer.id }))
      const topic = ctx.outbound(targets, str(input, 'topic'))
      if (!topic.text) return deny('topic is required')
      if (topic.text.length > 200) return deny('keep the topic under 200 characters, put details in the message')
      if (topic.findings.some(f => f.severity === 'block')) return deny(`the topic looks like it contains a secret (${describeFindings(topic.findings)}). Pick a plain topic.`)
      const raw = str(input, 'message')
      const msg = raw ? ctx.outbound(targets, raw) : null
      if (msg?.blocked) return deny(`quietsync blocked the first message: ${msg.blocked}`)
      const target = str(input, 'session')
      return ask(
        [
          `quietsync: start a ${peers.length > 1 ? `group link with ${peers.length} people` : 'link'}`,
          `to: ${peers.map(p => who(p.peer)).join(', ')}${target ? `, only their session "${target}"` : ''}`,
          `topic: "${topic.text}"`,
          `they'll see your name, this session's label "${view.session.label}" and device "${view.session.device}"`,
          ...peers.filter(p => p.policy.send === 'auto').map(p => `! auto-send is on for ${p.peer.label}: replies go out without asking you`),
          ...(msg ? findingLines(msg) : []),
          ...(msg ? [body('first message, delivered once they accept', msg.text)] : []),
        ].join('\n'),
      )
    }
    case 'send': {
      const id = str(input, 'link_id')
      const targets = view.links.filter(l => l.id === id || l.group?.id === id)
      if (!targets.length) return deny(`no active link or group "${id}". Check quietsync_status.`)
      for (const l of targets) {
        if (!l.caps.send) return deny(`your policy for ${l.peer.label} is "${l.role}", so your agent doesn't send to them. Tell your human what you'd have said instead.`)
        if (!l.peerCaps.receive) return deny(`${l.peer.label}'s side doesn't take messages on this link (they're send-only).`)
      }
      const o = ctx.outbound(targets.map(l => ({ linkId: l.id })), str(input, 'text'))
      if (o.blocked) return deny(`quietsync blocked this send: ${o.blocked}`)
      const auto = targets.every(l => l.send === 'auto')
      const streak = Math.max(...targets.map(l => l.autoStreak))
      const limit = Math.min(...targets.map(l => l.autoSendLimit))
      const hourly = auto ? targets.map(l => ({ link: l, sent: ctx.autoSent?.(l.peer.id) ?? 0 })).find(x => x.sent >= x.link.autoSendLimit) : undefined
      const held = auto
        ? holdContent(o, view, targets.map(l => l.peer), ctx) ?? (hourly ? `${hourly.sent} messages to ${hourly.link.peer.label} already went without asking in the last hour` : null)
        : null
      if (auto && streak < limit && !held) return allow('quietsync: auto-send is on for this link')
      const head = targets.length > 1 ? `quietsync: send to ${targets.length} people in group ${id}: ${targets.map(l => l.peer.label).join(', ')}` : `quietsync: send to ${who(targets[0]!.peer)}`
      const why = !auto
        ? 'you approve every send'
        : streak >= limit
          ? `auto-send paused: ${streak} sends in a row without you`
          : `auto-send held: ${held}`
      return ask(
        [
          head,
          `link "${targets[0]!.topic}", ${why}`,
          ...findingLines(o),
          ...(ctx.touches?.length ? [`your agent looked at since their last message: ${ctx.touches.slice(-6).join(', ')}${ctx.touches.length > 6 ? ` (+${ctx.touches.length - 6} more)` : ''}`] : []),
          body('message', o.text),
        ].join('\n'),
      )
    }
    case 'send_file': {
      const id = str(input, 'link_id')
      const path = str(input, 'path')
      const targets = view.links.filter(l => l.id === id || l.group?.id === id)
      if (!targets.length) return deny(`no active link or group "${id}". Check quietsync_status.`)
      if (!view.profile.files) return deny('sending files is turned off by your profile.')
      for (const l of targets) {
        if (!l.caps.send) return deny(`your policy for ${l.peer.label} is "${l.role}", so your agent doesn't send to them.`)
        if (!l.peerCaps.receive) return deny(`${l.peer.label}'s side doesn't take messages on this link.`)
      }
      const cls = ctx.paths.classify(path, ctx.cwd)
      if (cls === 'quietsync-secret' || cls === 'quietsync-config') return deny("quietsync's own files can't be sent.")
      if (cls === 'agent-config') return deny(`${path} holds the agent's own settings and can't be sent over quietsync.`)
      if (cls === 'sensitive') return deny(`${path} is a protected file (keys, credentials, .env and the like) and can't be sent over quietsync. If it really has to go, your human can share it some other way.`)
      let f: Inspection
      try {
        if (!ctx.inspectFile) return deny('quietsync is not running')
        f = ctx.inspectFile(id, path)
      } catch (e) {
        return deny(`can't read that file: ${(e as Error).message}`)
      }
      if (f.blocked) return deny(`quietsync blocked this file: ${f.blocked}`)
      const note = str(input, 'note')
      const o = note ? ctx.outbound(targets.map(l => ({ linkId: l.id })), note) : null
      if (o?.blocked) return deny(`quietsync blocked the note: ${o.blocked}`)
      const warnings = f.findings.filter(x => x.severity === 'warn')
      return {
        ...ask(
          [
            `quietsync: send a FILE to ${targets.length > 1 ? `${targets.length} people in group ${id}: ${targets.map(l => l.peer.label).join(', ')}` : who(targets[0]!.peer)}`,
            `file: ${f.name}, ${f.kind}${f.kind === 'binary' ? '' : ` (${f.mime})`}, ${formatSize(f.size)}, sha256 ${f.sha256.slice(0, 16)}…`,
            'the whole file leaves your machine; files are never redacted',
            ...f.notes.map(n => `! ${n}`),
            ...(warnings.length ? [`! check before approving: ${warnings.map(w => w.kind).join(', ')}`] : []),
            ...(cls === 'peer-content' ? ['! this is a file someone else sent you'] : []),
            ...inTurnLine(view),
            ...(o ? findingLines(o) : []),
            ...(o ? [body('note sent with it', o.text)] : []),
          ].join('\n'),
        ),
        fileSha: f.sha256,
      }
    }
    case 'message': {
      if (!view.profile.messages) return deny('messages are turned off by your profile.')
      const to = str(input, 'to')
      const hit = ctx.lookup(to)
      if (!hit) return deny(`no contact called "${to}". Check quietsync_status for names.`)
      if (hit.peer.rel === 'self') return deny('messages are for other people. To reach your own other sessions, use quietsync_connect with peer "me".')
      if (hit.policy.blockedBy) return deny(hit.policy.blockedBy)
      if (!hit.policy.caps.send) return deny(`your policy for ${hit.peer.label} is "${hit.policy.role}" (${ROLE_HELP[hit.policy.role]}), so your agent doesn't send to them.`)
      const targets = [{ peerId: hit.peer.id }]
      const subject = ctx.outbound(targets, str(input, 'subject'))
      if (!subject.text) return deny('subject is required')
      if (subject.text.length > 200) return deny('keep the subject under 200 characters, put details in the message')
      if (subject.findings.some(f => f.severity === 'block')) return deny(`the subject looks like it contains a secret (${describeFindings(subject.findings)}). Pick a plain subject.`)
      const ticket = str(input, 'ticket').trim().toUpperCase()
      if (ticket && !TICKET_RE.test(ticket)) return deny('ticket should look like PAY-123')
      const o = ctx.outbound(targets, str(input, 'text'))
      if (o.blocked) return deny(`quietsync blocked this message: ${o.blocked}`)
      const kind = messageKind(input)
      const question = kind !== 'fyi'
      const flow = hit.policy.flow.out[kind]
      if (flow === 'deny') return deny(`your quietsync rules don't let your agent send ${KIND_LABEL[kind]} to ${hit.peer.label}. Tell your human what you wanted to ask.`)
      const held = flow === 'auto' ? holdAuto(o, view, hit.peer, hit.policy, ctx) : null
      if (flow === 'auto' && !held) return allow(`quietsync: ${hit.policy.mode} mode for ${hit.peer.label}, sent without a dialog because it passed the checks`)
      return ask(
        [
          `quietsync: send ${kind === 'request' ? 'a REQUEST' : question ? 'a QUESTION' : 'a message'} to ${who(hit.peer)}`,
          flowLine(hit.policy, kind, held),
          `it waits at the relay if they're offline (up to 7 days); you'll see when it's delivered${question ? ', seen and answered' : ' and seen'}`,
          `subject: "${subject.text}"${ticket ? `, ticket ${ticket}` : ''}`,
          `they'll see your name and this session's label "${view.session.label}"`,
          ...inTurnLine(view),
          ...findingLines(o),
          ...(ctx.touches?.length ? [`your agent looked at: ${ctx.touches.slice(-6).join(', ')}${ctx.touches.length > 6 ? ` (+${ctx.touches.length - 6} more)` : ''}`] : []),
          body('message', o.text),
        ].join('\n'),
      )
    }
    case 'reply': {
      const id = str(input, 'message_id')
      const n = ctx.note?.(id)
      if (!n || n.dir !== 'in' || (n.kind !== 'ask' && n.kind !== 'request')) return deny(`no question "${id}" in your messages. Check quietsync_messages.`)
      if (n.answer || n.state === 'answered') return deny('you already answered this one.')
      if (n.state === 'dismissed') return deny('you dismissed this one.')
      if (!view.profile.messages) return deny('messages are turned off by your profile.')
      const hit = ctx.lookup(n.peer.id)
      if (!hit) return deny(`${n.peer.label} is no longer a contact.`)
      if (hit.policy.blockedBy) return deny(hit.policy.blockedBy)
      if (!hit.policy.caps.send) return deny(`your policy for ${n.peer.label} is "${hit.policy.role}", so your agent doesn't send to them.`)
      const o = ctx.outbound([{ peerId: n.peer.id }], str(input, 'text'))
      if (o.blocked) return deny(`quietsync blocked this answer: ${o.blocked}`)
      const flow = hit.policy.flow.out.answer
      if (flow === 'deny') return deny(`your quietsync rules don't let your agent answer ${n.peer.label}. Tell your human what you'd have said.`)
      const held = flow === 'auto' ? holdAuto(o, view, hit.peer, hit.policy, ctx) : null
      if (flow === 'auto' && !held) return allow(`quietsync: ${hit.policy.mode} mode for ${n.peer.label}, answered without a dialog because it passed the checks`)
      return ask(
        [
          `quietsync: answer ${who(n.peer)}`,
          flowLine(hit.policy, 'answer', held),
          `their question: ${shownSubject(n)}${n.ticket ? `, ticket ${n.ticket}` : ''}`,
          ...inTurnLine(view),
          ...findingLines(o),
          ...(ctx.touches?.length ? [`your agent looked at: ${ctx.touches.slice(-6).join(', ')}${ctx.touches.length > 6 ? ` (+${ctx.touches.length - 6} more)` : ''}`] : []),
          body('answer', o.text),
        ].join('\n'),
      )
    }
    case 'record': {
      if (!view.profile.records) return deny('posting records is turned off by your profile.')
      const r = ctx.record?.(str(input, 'message_id'), str(input, 'to'))
      if (!r || typeof r === 'string') return deny(r ?? 'quietsync is not running')
      return {
        ...ask(
          [
            `quietsync: post a copy of this thread to "${str(input, 'to')}" (${r.type})`,
            'this goes to a third place, outside the two of you. Secrets in it block the post.',
            ...(r.type === 'jira' && r.ticket ? [`${r.ticketBy === 'them' ? '! ' : ''}comments on ${r.ticket}${r.ticketBy === 'them' ? ', a ticket the other person chose' : ''}`] : []),
            ...inTurnLine(view),
            body('record', r.text),
          ].join('\n'),
        ),
        recordSha: r.sha,
      }
    }
    case 'accept': {
      const req = view.incoming.find(r => r.id === str(input, 'request_id'))
      if (!req) return deny(`no pending link request "${str(input, 'request_id')}"`)
      return ask(
        `quietsync: accept a link from ${who(req.peer)} about "${req.topic}"?\n` +
          'Their messages will reach this session as untrusted text' +
          (req.message ? `, starting with this one:\n${req.message}` : '.'),
      )
    }
    case 'setup': {
      const prof = str(input, 'profile')
      return ask(
        [
          `quietsync: set up this machine as "${str(input, 'name')}" on relay ${str(input, 'relay')}?`,
          `This creates a key pair in ${ctx.home}. Nothing is shared until you pair with someone or join a team.`,
          'quietsync lowers the risk of other agents talking to yours; it does not remove it. You approve every send: read each one. Details: docs/safety.md',
          ...(isProfile(prof) ? [`profile ${prof}: ${PROFILES[prof].summary}`] : []),
          ...(view.profile.org ? [`You're signed into the ${view.profile.org} plan, so you can only link with colleagues in your org's quietsync teams.`] : []),
        ].join('\n'),
      )
    }
    case 'join': {
      const code = str(input, 'code')
      const no = ctx.checkCode?.(code)
      if (no) return deny(no)
      return ask(`quietsync: use this code?\n${ctx.describeCode?.(code) ?? 'unreadable code'}`)
    }
    case 'invite':
      if (view.profile.orgOnly || !view.profile.external) {
        return deny(
          view.profile.org
            ? `contact invites are off: on the ${view.profile.org} plan you can only link with colleagues in your org's teams. Ask your admin for a team code instead.`
            : 'contact invites are turned off by your profile. Use a team instead.',
        )
      }
      return ask(
        'quietsync: create a one-time invite code? Whoever uses it first becomes a contact who can ask to link with you ' +
          '(each link still needs your OK). Share it only with the person you mean.',
      )
    case 'claim':
      return NONE
    default:
      return allow()
  }
}
