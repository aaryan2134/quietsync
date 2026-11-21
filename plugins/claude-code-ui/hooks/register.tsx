import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'
import type { Link, Note, Notes, Rel, Request, Role, View } from '../types'

type $ = Parameters<Hook<'session.start'>>[0]

const viewA = atom({ plugin: 'quietsync-ui', key: 'view' } as const, null)
const tokenA = atom({ plugin: 'quietsync-ui', key: 'token' } as const, null)
const seqA = atom({ plugin: 'quietsync-ui', key: 'seq' } as const, 0)
const confirmA = atom({ plugin: 'quietsync-ui', key: 'confirm' } as const, null)
const problemA = atom({ plugin: 'quietsync-ui', key: 'problem' } as const, null)
const notesA = atom({ plugin: 'quietsync-ui', key: 'notes' } as const, null)

const TINT: Record<Rel, { bg: string; border: string; tag: string }> = {
  external: { bg: '#3b0d16', border: 'red', tag: 'EXTERNAL' },
  team: { bg: '#332a00', border: 'yellow', tag: 'TEAMMATE' },
  self: { bg: '#0b2340', border: 'blue', tag: 'YOUR OTHER SESSION' },
}

const ROLES: Role[] = ['peer', 'asker', 'responder', 'listener', 'notifier', 'off']

const relWord = (r: Rel) => (r === 'self' ? 'your other session' : r === 'team' ? 'teammate' : 'external')

function oneWay(l: Link): string {
  if (!l.caps.send) return 'receive only: your agent does not reply'
  if (!l.caps.receive) return 'send only: their replies are dropped'
  if (!l.peerCaps.send) return "they won't reply"
  if (!l.peerCaps.receive) return "they don't read messages"
  return ''
}

async function socketPath($: $): Promise<string> {
  const sid = (await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12)
  const home = (await $.env.get('QUIETSYNC_HOME')) ?? `${await $.env.get('HOME')}/.quietsync`
  const run = (await $.env.get('QUIETSYNC_RUN_DIR')) ?? `${home}/run`
  return `${run}/${sid}.sock`
}

// Talks to this session's quietsync bridge over its unix socket.
async function call($: $, path: string, body?: unknown, token?: string | null): Promise<any> {
  try {
    const res = await $.http.fetch(`http://quietsync${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-quietsync-token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      socketPath: await socketPath($),
    })
    const data = res.text ? JSON.parse(res.text) : {}
    return res.ok ? data : { error: data.error ?? `HTTP ${res.status}` }
  } catch {
    return null
  }
}

// The human-control token comes over the engine's own MCP connection when it
// can, which the agent's shell can't reach. The socket claim is a fallback the
// bridge only honours before the agent has run anything.
async function claim($: $): Promise<string | null> {
  let token: string | null = null
  for (const server of ['plugin:quietsync:quietsync', 'quietsync']) {
    try {
      const r = await $.mcp.call(server, 'quietsync_claim', {})
      const first = r.content?.[0] as { type?: string; text?: string } | undefined
      if (!r.isError && first?.type === 'text' && first.text && /^[A-Za-z0-9_-]{16,}$/.test(first.text)) {
        token = first.text
        break
      }
    } catch {}
  }
  if (!token) {
    const r = await call($, '/mod/claim', {})
    if (r?.token) token = r.token
    else if (r?.error) {
      await update($, problemA, () => "couldn't attach to this session's quietsync controls. Restart the session to get the buttons back.")
      return null
    }
  }
  if (token) {
    await update($, tokenA, () => token)
    await update($, problemA, () => null)
  }
  return token
}

async function human($: $, action: string, body: Record<string, unknown>) {
  const token = await read($, tokenA)
  const r = await call($, `/human/${action}`, body, token)
  if (r?.error) $.ui.toast(`quietsync: ${r.error}`)
  if (r?.view) await update($, viewA, () => r.view)
  if (r?.notes !== undefined) await update($, notesA, () => r.notes as Notes | null)
  await update($, confirmA, () => null)
  return r
}

// The human chooses to hand the answer over, but the marked prompt still carries peer text.
async function carryOn($: $, key: string) {
  const r = await human($, 'note-continue', { id: key })
  if (r?.restricted) $.ui.toast(`quietsync: ${r.why === 'long' ? 'that answer is longer than the band shows' : 'that answer tripped the injection checks'}, so your agent reads it at peer privilege`)
  else if (r?.prompt) void $.prompt.submit({ text: `[quietsync:human]\n${r.prompt}` })
}

const STATE_WORD: Record<string, string> = { delivered: 'got', seen: 'saw', declined: 'declined' }

async function tick($: $) {
  const since = await read($, seqA)
  const r = await call($, `/poll?since=${since}`)
  if (!r || r.error) {
    await update($, viewA, () => null)
    return
  }
  let token = await read($, tokenA)
  if (!token) token = await claim($)
  await update($, viewA, () => r.view as View)
  await update($, seqA, () => r.seq as number)
  await update($, notesA, () => (r.notes ?? null) as Notes | null)
  const hold =
    r.held === 'hooks' && r.view?.pending
      ? 'holding peer messages until its safety hooks show up in this session. Type anything here to start.'
      : r.held === 'wakes'
        ? `holding peer messages: ${r.peerWakes} arrived in a row without you. Type anything here to let them through.`
        : null
  const prob = await read($, problemA)
  if (hold) await update($, problemA, () => hold)
  else if (prob?.startsWith('holding peer messages')) await update($, problemA, () => null)

  for (const e of r.events as Array<Record<string, any>>) {
    if (e.kind === 'request') void $.ui.notify(`${e.peer.label} (${relWord(e.peer.rel)}) wants to link: ${e.topic}`, { title: 'quietsync' })
    if (e.kind === 'file') $.ui.toast(`quietsync: ${e.peer.label} sent ${e.name} (${Math.max(1, Math.round(e.size / 1024))} KB), saved unopened in your inbox`)
    if (e.kind === 'linked' && e.remembered) $.ui.toast(`quietsync: auto-accepted ${e.peer.label} (you chose "always accept")`)
    if (e.kind === 'dropped' && /signature|decrypt|not a contact|too fast/.test(e.reason)) $.ui.toast(`quietsync dropped a message: ${e.reason}`)
    if (e.kind === 'note') void $.ui.notify(e.noteKind === 'reply' ? `${e.peer.label} answered "${e.subject}"` : `${e.peer.label} ${e.noteKind === 'ask' ? 'asks' : e.noteKind === 'request' ? 'requests' : 'says'}: ${e.subject}`, { title: 'quietsync' })
    if (e.kind === 'note.applied') $.ui.toast(`quietsync: ${e.peer.label}'s ${e.noteKind === 'reply' ? 'answer' : e.noteKind === 'note' ? 'FYI' : e.noteKind === 'ask' ? 'question' : 'request'} "${e.subject}" went to Claude on its own (${e.mode} mode)`)
    if (e.kind === 'note.sent' && e.auto) $.ui.toast(`quietsync: sent to ${e.peer.label} without a dialog (${e.mode} mode, it passed the checks)`)
    if (e.kind === 'keys.changed') void $.ui.notify(`${e.peer.label}'s keys changed. Their mode is back to ask; compare safety numbers with: quietsync verify ${e.peer.label}`, { title: 'quietsync' })
    if (e.kind === 'note.state' && STATE_WORD[e.state]) $.ui.toast(`quietsync: ${e.peer.label} ${STATE_WORD[e.state]} "${e.subject}"`)
  }

  const notices = r.notices as Array<{ id: number; kind: string; text: string }>
  if (!notices.length || !token) return
  const requests = notices.filter(n => n.kind === 'request')
  const wake = notices.filter(n => n.kind !== 'request')
  if (requests.length) await call($, '/delivered', { ids: requests.map(n => n.id), seenByModel: false }, token)
  if (wake.length) {
    await call($, '/delivered', { ids: wake.map(n => n.id) }, token)
    void $.prompt.submit({ text: `[quietsync]\n${wake.map(n => n.text).join('\n\n')}` })
  }
}

function inputOf(e: Record<string, unknown>): Record<string, unknown> {
  const { tool: _t, tool_use_id: _id, consent: _c, agentId: _a, requestMeta: _m, ...args } = e
  return args
}

const LINKS_HELP = '/links shows links and requests. /links pause stops new requests reaching this session, /links resume undoes it, /links done ends the gating after someone\'s message, /links mode <role|off> narrows this session (roles: ' + ROLES.join(', ') + ').'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    void claim($)
    $.clock.every(1000, () => tick($))
    await $.command.register({ name: 'links', description: 'quietsync: links, requests, pause/resume and session mode' }).catch(() => {})
    return started
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const d = await call($, '/hook/pre-tool-use', { tool_name: e.tool, tool_input: inputOf(e as Record<string, unknown>), source: 'mod' })
    if (d?.decision === 'ask') return { ask: d.reason }
    if (d?.decision === 'deny') return { deny: d.reason }
    if (d?.decision === 'allow') return { allow: true }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer') void call($, '/hook/user-prompt-submit', { mod: true, human: true })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'links' }, async ($, e) => {
    const [sub, arg] = e.args.trim().split(/\s+/)
    const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (sub && !typed) return { text: 'quietsync: session changes only work when you type /links yourself.' }
    if (sub === 'pause' || sub === 'resume') {
      const r = await human($, 'session', { paused: sub === 'pause' })
      return { text: r?.ok ? (sub === 'pause' ? 'quietsync: paused, new link requests skip this session' : 'quietsync: taking link requests again') : `quietsync: ${r?.error ?? 'not running'}` }
    }
    if (sub === 'done') {
      const r = await human($, 'exposure-end', {})
      return { text: r?.ok ? "quietsync: done with the peer text in this session; tools aren't gated for it any more" : `quietsync: ${r?.error ?? 'not running'}` }
    }
    if (sub === 'mode') {
      const mode = arg === 'off' || !arg ? null : (arg as Role)
      if (mode && !ROLES.includes(mode)) return { text: LINKS_HELP }
      const r = await human($, 'session', { mode })
      return { text: r?.ok ? `quietsync: this session is ${mode ? `now limited to "${mode}"` : 'back to your normal policy'}` : `quietsync: ${r?.error ?? 'not running'}` }
    }
    if (sub) return { text: LINKS_HELP }
    const v = await read($, viewA)
    if (!v?.identity) return { text: 'quietsync is not running in this session. Check `quietsync doctor` and that the quietsync plugin is installed.' }
    const lines = [
      `you: ${v.identity.name} (${v.identity.fingerprint}), relay ${v.relay.connected ? 'connected' : 'offline'}, delivery ${v.delivery}${v.paused ? ', PAUSED' : ''}${v.mode ? `, mode ${v.mode}` : ''}`,
      `profile ${v.profile.name}${v.profile.orgOnly ? `, org-only${v.profile.org ? ` (${v.profile.org})` : ''}` : ''}${v.profile.requireVerified ? ', verified contacts only' : ''}. Details: quietsync profile`,
      ...v.incoming.map(r => `request ${r.id}: ${r.peer.label} (${relWord(r.peer.rel)}) "${r.topic}", use the band to accept or decline`),
      ...v.links.map(l => `link ${l.id}${l.group ? ` [group ${l.group.id}]` : ''}: ${l.peer.label} (${relWord(l.peer.rel)}) "${l.topic}", ${l.role}, send=${l.send}, isolation ${l.isolation}, sent ${l.sent}, received ${l.received}`),
      ...v.outgoing.map(o => `waiting on ${o.peer.label} for "${o.topic}"`),
      LINKS_HELP,
    ]
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, viewA)
    const problem = await read($, problemA)
    const notes = await read($, notesA)
    const busy = v?.identity && (v.exposure ||
      v.links.length || v.incoming.length || v.outgoing.length || v.paused || v.policyChanged || notes?.inbox.length || notes?.answers.length || notes?.waiting.length)
    if (!problem && !busy) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const confirm = await read($, confirmA)

    const requestRow = (r: Request) => {
      const t = TINT[r.peer.rel]
      const flagged = [...r.topicFlags, ...r.flags].filter(f => f !== 'truncated')
      const preview = r.message ? (r.message.length > 280 ? `${r.message.slice(0, 280)}…` : r.message) : ''
      return (
        <Box key={`req-${r.id}`} flexDirection="column" borderStyle="round" borderColor={t.border} backgroundColor={t.bg} paddingX={1}>
          <Text color="white" bold>
            {`⚠ QUIETSYNC REQUEST · ${t.tag} · ${r.peer.label} (key ${r.peer.fingerprint.slice(0, 9)}) wants to link about "${r.topic}"${r.group ? ` · group of ${r.group.size}` : ''}`}
          </Text>
          <Text color="white" dimColor>
            {`from their session "${r.session.label}" on ${r.session.device}${r.peerCaps.send ? '' : ' · they only listen'}${r.peerCaps.receive ? '' : ' · they only send'}${r.session.kept ? ' · their company keeps a copy' : ''}. Accepting lets their agent's messages reach this session as untrusted text.`}
          </Text>
          {preview ? <Text color="white">{`first message: ${preview}`}</Text> : null}
          {flagged.length ? <Text color="red" bold>{`tripped injection checks: ${flagged.join(', ')}`}</Text> : null}
          <Box flexDirection="row" gap={1}>
            <Button key={`acc-${r.id}`} label="Accept" hotkey="a" onPress={() => human($, 'accept', { id: r.id })} />
            <Button key={`dec-${r.id}`} label="Decline" hotkey="d" onPress={() => human($, 'decline', { id: r.id })} />
            {r.peer.rel !== 'self' && v?.profile.autoAccept ? (
              <Button key={`always-${r.id}`} label={`Always accept from ${r.peer.name}`} onPress={() => human($, 'accept', { id: r.id, remember: true })} />
            ) : null}
          </Box>
        </Box>
      )
    }

    const linkRow = (l: Link) => {
      const t = TINT[l.peer.rel]
      const confirming = confirm === l.id
      const note = oneWay(l)
      return (
        <Box key={`link-${l.id}`} flexDirection="column" borderStyle="round" borderColor={l.send === 'auto' || l.allowSecrets ? 'red' : t.border} backgroundColor={t.bg} paddingX={1}>
          <Text color="white" bold>
            {`⛓ LINKED · ${t.tag} · ${l.peer.label} · "${l.topic}"${l.group ? ` · group ${l.group.id}` : ''} · peer text is untrusted · ${l.send === 'auto' ? 'AUTO-SEND ON' : 'you approve every send'}${l.mode ? ` · mode ${l.mode}` : ''}${l.allowSecrets ? ' · SECRETS ALLOWED' : ''}${l.peerSession.kept ? ' · their company keeps a copy' : ''}`}
          </Text>
          {note || l.role !== 'peer' || l.isolation === 'strict' ? (
            <Text color="white" dimColor>{[l.role !== 'peer' ? `role ${l.role}` : '', note, l.isolation === 'strict' ? 'strict isolation: tools other than reading ask while this is open' : ''].filter(Boolean).join(' · ')}</Text>
          ) : null}
          {v?.tainted?.linkId === l.id ? <Text color="white" dimColor>{`this turn was started by ${l.peer.label}: anything beyond reading files asks you first`}</Text> : null}
          {confirming ? (
            <Text color="red" bold>
              {`Auto-send lets your agent reply to ${l.peer.label} without showing you first (up to ${l.autoSendLimit} in a row, and never when the scanner flags something). A prompt-injected or compromised peer could pull answers out unseen.`}
            </Text>
          ) : null}
          <Box flexDirection="row" gap={1}>
            {confirming
              ? [
                  <Button key={`auto-yes-${l.id}`} label="Turn on auto-send" hotkey="y" onPress={() => human($, 'policy', { id: l.id, send: 'auto' })} />,
                  <Button key={`auto-no-${l.id}`} label="Cancel" hotkey="n" onPress={() => update($, confirmA, () => null)} />,
                ]
              : [
                  <Button key={`close-${l.id}`} label="Close link" hotkey="c" onPress={() => human($, 'close', { id: l.id })} />,
                  ...(!l.caps.send || (!v?.profile.autoSend && l.send !== 'auto')
                    ? []
                    : l.send === 'auto'
                      ? [<Button key={`ask-${l.id}`} label="Back to approving sends" hotkey="b" onPress={() => human($, 'policy', { id: l.id, send: 'ask' })} />]
                      : [<Button key={`auto-${l.id}`} label="Auto-send…" hotkey="u" onPress={() => update($, confirmA, () => l.id)} />]),
                  ...(l.allowSecrets ? [<Button key={`nosec-${l.id}`} label="Block secrets again" onPress={() => human($, 'policy', { id: l.id, allowSecrets: false })} />] : []),
                ]}
          </Box>
        </Box>
      )
    }

    const clip = (s: string) => (s.length > 280 ? `${s.slice(0, 280)}…` : s)
    const flagged = (f: string[]) => f.filter(x => x !== 'truncated')

    const inboxRow = (n: Note) => {
      const t = TINT[n.peer.rel]
      const bad = flagged(n.flags)
      return (
        <Box key={`note-${n.key}`} flexDirection="column" borderStyle="round" borderColor={t.border} backgroundColor={t.bg} paddingX={1}>
          <Text color="white" bold>
            {`✉ QUIETSYNC MESSAGE · ${t.tag} · ${n.peer.label} ${n.kind === 'ask' ? 'asks' : n.kind === 'request' ? 'requests' : 'says'}: "${bad.length ? '(subject withheld)' : n.subject}"${n.ticket ? ` · ${n.ticket}` : ''}`}
          </Text>
          <Text color="white" dimColor>{`from their session "${n.session.label}" · their words, untrusted · your agent only sees it if you hand it over${n.session.kept ? ' · their company keeps a copy' : ''}`}</Text>
          <Text color="white">{clip(n.text)}</Text>
          {bad.length ? <Text color="red" bold>{`tripped injection checks: ${bad.join(', ')}`}</Text> : null}
          <Box flexDirection="row" gap={1}>
            {n.kind === 'ask' || n.kind === 'request'
              ? [
                  <Button key={`ans-${n.key}`} label="Answer with Claude" onPress={() => human($, 'note-answer', { id: n.key })} />,
                  <Button key={`later-${n.key}`} label="Later" onPress={() => human($, 'note-later', { id: n.key })} />,
                  <Button key={`dis-${n.key}`} label="Dismiss" onPress={() => human($, 'note-dismiss', { id: n.key })} />,
                ]
              : [
                  <Button key={`ok-${n.key}`} label="Got it" onPress={() => human($, 'note-read', { id: n.key })} />,
                  <Button key={`show-${n.key}`} label="Show Claude" onPress={() => human($, 'note-answer', { id: n.key })} />,
                  <Button key={`later-${n.key}`} label="Later" onPress={() => human($, 'note-later', { id: n.key })} />,
                ]}
          </Box>
        </Box>
      )
    }

    const answerRow = (n: Note) => {
      const t = TINT[n.peer.rel]
      const bad = flagged(n.answer?.flags ?? [])
      const fits = n.answer?.fits ?? false
      return (
        <Box key={`answer-${n.key}`} flexDirection="column" borderStyle="round" borderColor={bad.length ? 'red' : 'green'} backgroundColor={t.bg} paddingX={1}>
          <Text color="white" bold>{`✉ ANSWER · ${t.tag} · ${n.peer.label} answered your question "${n.subject}"`}</Text>
          <Text color="white">{fits ? (n.answer?.text ?? '') : clip(n.answer?.text ?? '')}</Text>
          {bad.length ? (
            <Text color="red" bold>{`tripped injection checks: ${bad.join(', ')}. Continue runs at peer privilege.`}</Text>
          ) : fits ? (
            <Text color="white" dimColor>{'Continue hands it to your agent as information from them, not instructions, in your turn.'}</Text>
          ) : (
            <Text color="yellow">{`longer than the band shows (quietsync messages show ${n.id}), so Continue runs at peer privilege`}</Text>
          )}
          <Box flexDirection="row" gap={1}>
            <Button key={`go-${n.key}`} label="Continue" onPress={() => carryOn($, n.key)} />
            <Button key={`later-${n.key}`} label="Later" onPress={() => human($, 'note-later', { id: n.key })} />
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {problem ? <Text color="red" bold>{`quietsync: ${problem}`}</Text> : null}
        {v?.kept && (v.links.length || notes?.inbox.length || notes?.answers.length) ? <Text color="white" dimColor>quietsync: your company keeps a sealed copy of these messages</Text> : null}
        {v?.exposure && !v.links.length ? (
          <Box flexDirection="row" gap={1}>
            <Text color="yellow">{`quietsync: ${v.exposure.by}'s words are in this session, so ${v.exposure.isolation === 'strict' ? 'tools beyond reading ask you' : 'sending data out and sensitive files ask you'}`}</Text>
            <Button key="exposure-end" label="Done with it" onPress={() => human($, 'exposure-end', {})} />
          </Box>
        ) : null}
        {notes?.answers.map(answerRow)}
        {notes?.inbox.map(inboxRow)}
        {notes?.waiting.length ? <Text dimColor>{`quietsync: asked ${notes.waiting.map(w => `${w.peer.name} "${w.subject}" (${w.state})`).join(', ')}`}</Text> : null}
        {v?.policyChanged ? <Text color="yellow">{'quietsync: policy.json changed while this session runs. Tightening applies now, loosening only in new sessions.'}</Text> : null}
        {v?.paused ? <Text color="yellow">{'quietsync: paused, new link requests skip this session (/links resume)'}</Text> : null}
        {v?.incoming.map(requestRow)}
        {v?.links.map(linkRow)}
        {v?.outgoing.length ? (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{`quietsync: waiting on ${v.outgoing.map(o => `${o.peer.label} ("${o.topic}")`).join(', ')}`}</Text>
            {v.outgoing.map(o => (
              <Button key={`wd-${o.id}`} label={`Withdraw ${o.peer.name}`} hotkey="w" onPress={() => human($, 'close', { id: o.id })} />
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}
