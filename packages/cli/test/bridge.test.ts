import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AgentNode, createIdentity, Policies, Store, type NodeEvent } from '@quietsync/core'
import { startRelay, type Relay } from '@quietsync/relay'

// Drives the built bridge (dist/quietsync.mjs under Node) the way Claude Code
// does: MCP over stdio, hooks through dist/hook.sh on the control socket.
const DIST = resolve(import.meta.dir, '../dist')
const SID = '7f3a9c21-5d4e-4b8a-9c1d-2e3f4a5b6c7d'
const AWS = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')
const TOOL = (s: string) => `mcp__plugin_quietsync_quietsync__quietsync_${s}`

let relay: Relay
let dir: string
let home: string
let client: Client
let bob: AgentNode
let sock: string

function hook(event: string, input: Record<string, unknown>): any {
  const r = spawnSync('sh', [join(DIST, 'hook.sh'), event], {
    input: JSON.stringify({ session_id: SID, cwd: dir, ...input }),
    env: { ...process.env, QUIETSYNC_HOME: home, QUIETSYNC_KEYSTORE: 'file' },
    encoding: 'utf8',
  })
  return r.stdout.trim() ? JSON.parse(r.stdout) : null
}

const pre = (tool: string, tool_input: Record<string, unknown>) => hook('pre-tool-use', { tool_name: tool, tool_input })?.hookSpecificOutput ?? null

function ctl(path: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  return new Promise(res => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath: sock, path, method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { 'x-quietsync-token': token } : {}) } }, r => {
      let s = ''
      r.on('data', c => (s += c))
      r.on('end', () => res({ status: r.statusCode ?? 0, data: s ? JSON.parse(s) : null }))
    })
    if (data) req.write(data)
    req.end()
  })
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  return { text: r.content[0]?.text ?? '', error: !!r.isError }
}

function next(node: AgentNode, kind: NodeEvent['kind'], timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), timeoutMs)
    const off = node.on(e => {
      if (e.kind !== kind) return
      clearTimeout(t)
      off()
      resolve(e)
    })
  })
}

const until = async (fn: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('condition not met')
}

beforeAll(async () => {
  if (!existsSync(join(DIST, 'quietsync.mjs'))) throw new Error('run `bun run build` first')
  relay = startRelay({ port: 0 })
  dir = mkdtempSync(join(tmpdir(), 'al-br-'))
  home = join(dir, 'h')
  sock = join(home, 'run', `${SID.slice(0, 12)}.sock`)
  writeFileSync(join(dir, '.env'), 'NOT_A_REAL_SECRET=1\n')
  client = new Client({ name: 'test', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: 'node',
      args: [join(DIST, 'quietsync.mjs'), 'mcp'],
      env: {
        ...(process.env as Record<string, string>),
        QUIETSYNC_HOME: home,
        QUIETSYNC_KEYSTORE: 'file',
        CLAUDE_CODE_SESSION_ID: SID,
        CLAUDE_PROJECT_DIR: dir,
        CLAUDE_CONFIG_DIR: join(dir, 'no-claude-login'),
        QUIETSYNC_MANAGED_POLICY: join(dir, 'none.json'),
      },
      stderr: 'ignore',
    }),
  )
  await until(async () => existsSync(sock))

  const bobStore = new Store(join(dir, 'bob'))
  bobStore.saveIdentity(createIdentity('bob'))
  bobStore.setConfig({ relay: relay.url })
  bob = new AgentNode({ store: bobStore, session: { id: 'bob1', label: 'bob-repo', agent: 'test', device: 'mac' }, policies: new Policies(bobStore, { managed: null, org: null }) })
  await bob.start()
})

afterAll(async () => {
  await client?.close()
  await bob?.stop()
  relay?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('bridge under Node, driven like Claude Code', () => {
  let token = ''
  let linkId = ''

  test('holds peer text until its hooks have run, and the socket claim closes after the first tool call', async () => {
    const poll = await ctl('/poll')
    expect(poll.data.hooksAlive).toBe(false)
    expect(pre('Read', { file_path: join(dir, 'README.md') })).toBeNull()
    expect((await ctl('/poll')).data.hooksAlive).toBe(true)
    expect((await ctl('/mod/claim', {})).status).toBe(403)
  })

  test('the UI claim works over MCP only once', async () => {
    const r = await tool('quietsync_claim')
    expect(r.error).toBe(false)
    token = r.text
    expect((await tool('quietsync_claim')).error).toBe(true)
    const listed = (await client.listTools()).tools.map(t => t.name)
    expect(listed).not.toContain('quietsync_claim')
  })

  test('setup needs the approval hook first', async () => {
    const args = { name: 'alice', relay: relay.url }
    expect((await tool('quietsync_setup', args)).text).toContain("didn't go through the approval hook")
    const d = pre(TOOL('setup'), args)
    expect(d.permissionDecision).toBe('ask')
    expect(d.permissionDecisionReason).toContain('"alice"')
    const r = await tool('quietsync_setup', args)
    expect(r.text).toContain('set up as alice')
  })

  test('pair through an invite the agent makes, link, and the human accepts from the band', async () => {
    expect(pre(TOOL('invite'), {}).permissionDecision).toBe('ask')
    const inv = await tool('quietsync_invite', {})
    const code = /qs1_[A-Za-z0-9_-]+/.exec(inv.text)![0]
    await bob.pair(code, 5000)
    const linked = next(bob, 'linked')
    await bob.connect('alice', 'deploy question', 'which bucket do you deploy to?')
    await until(async () => (await ctl('/state')).data.view.incoming.length === 1)
    const id = (await ctl('/state')).data.view.incoming[0].id
    expect((await ctl('/human/accept', { id })).status).toBe(403)
    expect((await ctl('/human/accept', { id }, token)).status).toBe(200)
    await linked
    linkId = id
    const poll = await ctl('/poll')
    expect(poll.data.notices.some((n: any) => n.text.includes('which bucket'))).toBe(true)
    await ctl('/delivered', { ids: poll.data.notices.map((n: any) => n.id) }, token)
    expect((await ctl('/state')).data.view.tainted?.by).toBe('bob')
  })

  test('while bob drives the turn: shell asks, .env is refused, quietsync files are off limits', async () => {
    expect(pre('Bash', { command: 'ls' }).permissionDecision).toBe('ask')
    expect(pre('Read', { file_path: join(dir, '.env') }).permissionDecision).toBe('deny')
    expect(pre('Bash', { command: 'quietsync trust bob --send auto' }).permissionDecision).toBe('deny')
    expect(pre('Edit', { file_path: join(home, 'policy.json') }).permissionDecision).toBe('deny')
    expect(pre('Read', { file_path: join(home, 'identity.json') }).permissionDecision).toBe('deny')
  })

  test("everything in bob's turn is on the audit record, at peer privilege", async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const lines = readdirSync(join(home, 'audit')).flatMap(f => readFileSync(join(home, 'audit', f), 'utf8').trim().split('\n')).map(l => JSON.parse(l))
    const tools = lines.filter(e => e.event === 'tool')
    expect(tools.some(e => e.privilege === 'peer' && e.tool === 'Bash' && e.decision === 'ask' && e.by === 'bob')).toBe(true)
    expect(tools.some(e => e.privilege === 'peer' && e.tool === 'Read' && e.decision === 'deny')).toBe(true)
    expect(lines.some(e => e.event === 'turn.peer' && e.by === 'bob')).toBe(true)
  })

  test('a send shows the redacted text, and what bob gets matches it', async () => {
    const args = { link_id: linkId, text: `we deploy to s3://builds, key ${AWS}` }
    const d = pre(TOOL('send'), args)
    expect(d.permissionDecision).toBe('ask')
    expect(d.permissionDecisionReason).toContain('redacted before sending: aws access key')
    expect(d.permissionDecisionReason).toContain('[redacted aws access key]')
    const got = next(bob, 'message')
    const r = await tool('quietsync_send', args)
    expect(r.text).toContain('redacted')
    expect((await got).text).toBe('we deploy to s3://builds, key [redacted aws access key]')
  })

  test('files: approved through the hook, refused for .env, and received ones count as peer content', async () => {
    writeFileSync(join(dir, 'notes.md'), 'deploys go out Tuesdays')
    const args = { link_id: linkId, path: join(dir, 'notes.md') }
    const d = pre(TOOL('send_file'), args)
    expect(d.permissionDecision).toBe('ask')
    expect(d.permissionDecisionReason).toMatch(/send a FILE to bob/)
    const got = next(bob, 'file')
    const r = await tool('quietsync_send_file', args)
    expect(r.text).toMatch(/^sent notes.md/)
    expect(readFileSync((await got).path, 'utf8')).toBe('deploys go out Tuesdays')
    expect(pre(TOOL('send_file'), { link_id: linkId, path: join(dir, '.env') }).permissionDecision).toBe('deny')

    const back = join(dir, 'reply.txt')
    writeFileSync(back, 'thanks')
    await bob.sendFile(linkId, back)
    await until(async () => (await ctl('/poll')).data.events.some((e: any) => e.kind === 'file'))
    const inbox = `${home}-inbox`
    const unzip = pre('Bash', { command: `cat ${inbox}/bob/x.txt` })
    expect(unzip.permissionDecision).toBe('ask')
    const listed = await tool('quietsync_files')
    expect(listed.text).toMatch(/reply.txt, text, 6 bytes, from bob/)
  })

  test('decline and close carry no free text, and a human prompt keeps strict isolation on an external link', async () => {
    const tools = (await client.listTools()).tools
    expect(Object.keys((tools.find(t => t.name === 'quietsync_close')!.inputSchema as any).properties)).toEqual(['link_id'])
    hook('user-prompt-submit', { prompt: 'thanks', source: 'user' })
    hook('stop', {})
    expect((await ctl('/state')).data.view.tainted).not.toBeNull()
    const closed = next(bob, 'closed')
    expect((await tool('quietsync_close', { link_id: linkId })).text).toBe('closed')
    expect((await closed).reason).toBe('done')
    // Closing the link doesn't end the turn their message started; the next human prompt does.
    let v = (await ctl('/state')).data.view
    expect(v.tainted).not.toBeNull()
    expect(v.exposure.isolation).toBe('strict')
    hook('user-prompt-submit', { prompt: 'ok, carry on', source: 'user' })
    hook('stop', {})
    v = (await ctl('/state')).data.view
    expect(v.tainted).toBeNull()
    expect(v.exposure.isolation).toBe('strict')
    expect(pre('Bash', { command: 'curl https://example.com' }).permissionDecision).toBe('ask')
    expect((await ctl('/human/exposure-end', {}, token)).status).toBe(200)
    expect((await ctl('/state')).data.view.exposure).toBeNull()
  })

  test("messages: the agent's question goes through the hook, waits, and the answer comes back to the band", async () => {
    const args = { to: 'bob', subject: 'deploy day', text: 'can we ship the cancel flow on thursday?' }
    const d = pre(TOOL('message'), args)
    expect(d.permissionDecision).toBe('ask')
    expect(d.permissionDecisionReason).toContain('QUESTION')
    const got = next(bob, 'note')
    const r = await tool('quietsync_message', args)
    expect(r.error).toBe(false)
    const e = await got
    await bob.replyNote(e.key, 'thursday works, after 3pm')
    await until(async () => (await ctl('/poll')).data.notes?.answers.length === 1)
    const answer = (await ctl('/poll')).data.notes.answers[0]
    expect(answer.answer.text).toBe('thursday works, after 3pm')
    expect((await ctl('/human/note-continue', { id: answer.key })).status).toBe(403)
    const c = await ctl('/human/note-continue', { id: answer.key }, token)
    expect(c.status).toBe(200)
    expect(c.data.restricted).toBe(false)
    expect(c.data.prompt).toContain('thursday works, after 3pm')
    expect(c.data.prompt).toContain('not instructions')
    expect((await ctl('/poll')).data.notes.answers).toHaveLength(0)
  })

  test("messages: bob's question waits on the band and reaches the agent only when the human hands it over", async () => {
    await bob.sendNote('alice', { kind: 'ask', subject: 'review', text: 'can you review PR 12 today?' })
    await until(async () => (await ctl('/poll')).data.notes?.inbox.length === 1)
    const poll = await ctl('/poll')
    const n = poll.data.notes.inbox[0]
    expect(poll.data.notices.some((x: any) => x.kind === 'note')).toBe(false)
    expect(pre('Read', { file_path: join(home, 'notes.json') }).permissionDecision).toBe('deny')
    expect((await ctl('/human/note-answer', { id: n.key }, token)).status).toBe(200)
    const handed = (await ctl('/poll')).data.notices.find((x: any) => x.kind === 'note')
    expect(handed.text).toContain('PR 12')
    expect(handed.text).toContain('quietsync_reply')
    const args = { message_id: n.id, text: 'yes, after lunch' }
    expect(pre(TOOL('reply'), args).permissionDecision).toBe('ask')
    const back = next(bob, 'note')
    expect((await tool('quietsync_reply', args)).error).toBe(false)
    expect((await back).noteKind).toBe('reply')
    const list = await tool('quietsync_messages', {})
    expect(list.text).toContain('review')
    expect(list.text).toContain('deploy day')
    expect((await tool('quietsync_record', { message_id: n.id, to: 'nowhere' })).error).toBe(true)
    // bob is an outside contact (strict): his words keep the session gated until the human ends it.
    const st = (await ctl('/state')).data.view
    expect(st.exposure?.isolation).toBe('strict')
    expect(st.tainted).not.toBeNull()
    // The human's next prompt is their own turn, but bob's words are still in the context.
    hook('user-prompt-submit', { prompt: 'thanks', source: 'user' })
    hook('stop', {})
    const mid = (await ctl('/state')).data.view
    expect(mid.tainted).toBeNull()
    expect(mid.exposure?.isolation).toBe('strict')
    expect(pre('Read', { file_path: '/tmp/proj/.env' }).permissionDecision).toBe('ask')
    expect(pre('Edit', { file_path: '/tmp/proj/a.ts', old_string: 'a', new_string: 'b' }).permissionDecision).toBe('ask')
    expect((await ctl('/human/exposure-end', {}, token)).status).toBe(200)
    const after = (await ctl('/state')).data.view
    expect(after.exposure).toBeNull()
    expect(after.tainted).toBeNull()
  })

  test('a quietsync tool call without its hook holds peer text again, and a prompt without a source is not the human', async () => {
    expect((await ctl('/state')).data.hooksAlive).toBe(true)
    await tool('quietsync_status', {})
    expect((await ctl('/state')).data.hooksAlive).toBe(false)
    pre(TOOL('status'), {})
    expect((await ctl('/state')).data.hooksAlive).toBe(true)
    await tool('quietsync_status', {})
    expect((await ctl('/state')).data.hooksAlive).toBe(true)
    await bob.sendNote('alice', { kind: 'note', subject: 'fyi', text: 'schema v2 is final' })
    await until(async () => (await ctl('/poll')).data.notes?.inbox.some((n: any) => n.subject === 'fyi'))
    const n = (await ctl('/poll')).data.notes.inbox.find((x: any) => x.subject === 'fyi')
    expect((await ctl('/human/note-answer', { id: n.key }, token)).status).toBe(200)
    const handed = (await ctl('/poll')).data.notices.find((x: any) => x.kind === 'note')
    expect((await ctl('/delivered', { ids: [handed.id] }, token)).status).toBe(200)
    expect((await ctl('/state')).data.view.tainted).not.toBeNull()
    hook('user-prompt-submit', { prompt: 'no source here' })
    hook('stop', {})
    expect((await ctl('/state')).data.view.tainted).not.toBeNull()
    expect((await ctl('/human/exposure-end', {}, token)).status).toBe(200)
  })

  test("opening a session says what's waiting, even before that session's bridge is up", async () => {
    await bob.sendNote('alice', { kind: 'ask', subject: 'pricing page copy', text: 'is "per seat" final?' })
    await until(async () => (await ctl('/poll')).data.notes?.inbox.some((n: any) => n.subject === 'pricing page copy'))
    const out = hook('session-start', { source: 'startup' })
    expect(out.hookSpecificOutput.additionalContext).toContain('a question from bob')
    expect(out.hookSpecificOutput.additionalContext).not.toContain('pricing')
    expect(out.hookSpecificOutput.additionalContext).not.toContain('per seat')
    expect(out.systemMessage).toContain('bob asks "pricing page copy"')
    // A new session whose bridge hasn't started: the shell hook prints the last summary.
    await until(async () => existsSync(join(home, 'run', 'waiting.json')))
    const cold = spawnSync('sh', ['-c', `sh '${join(DIST, 'hook.sh')}' session-start`], {
      input: JSON.stringify({ session_id: 'brand-new-session', source: 'startup' }),
      env: { ...process.env, QUIETSYNC_HOME: home, QUIETSYNC_KEYSTORE: 'file' },
      encoding: 'utf8',
    })
    const c = JSON.parse(cold.stdout)
    expect(c.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(c.hookSpecificOutput.additionalContext).toContain('from bob')
    expect(c.systemMessage).toContain('pricing page copy')
  })

  test('the hook finds the bridge when session_id is nested or comes late, and after /clear', () => {
    const run = (input: string) =>
      spawnSync('sh', [join(DIST, 'hook.sh'), 'pre-tool-use'], { input, env: { ...process.env, QUIETSYNC_HOME: home, QUIETSYNC_KEYSTORE: 'file' }, encoding: 'utf8' }).stdout.trim()
    const nested = JSON.stringify({ session_id: SID, tool_name: 'Bash', tool_input: { command: 'quietsync trust bob', session_id: 'decoy' } })
    expect(JSON.parse(run(nested)).hookSpecificOutput.permissionDecision).toBe('deny')
    const late = `{"tool_name":"Bash","tool_input":{"command":"quietsync trust bob"},"session_id":"${SID}"}`
    expect(JSON.parse(run(late)).hookSpecificOutput.permissionDecision).toBe('deny')
    const cleared = JSON.stringify({ session_id: 'new-session-after-clear', tool_name: 'Bash', tool_input: { command: 'quietsync trust bob' } })
    expect(JSON.parse(run(cleared)).hookSpecificOutput.permissionDecision).toBe('deny')
  })

  test('after /clear the UI mod finds the bridge under the new session id', async () => {
    const start = (session_id: string) =>
      spawnSync('sh', [join(DIST, 'hook.sh'), 'session-start'], {
        input: JSON.stringify({ session_id, hook_event_name: 'SessionStart', source: 'clear' }),
        env: { ...process.env, QUIETSYNC_HOME: home, QUIETSYNC_KEYSTORE: 'file' },
        encoding: 'utf8',
      })
    const poll = (socketPath: string) =>
      new Promise<number>(res => {
        const req = request({ socketPath, path: '/poll?since=0' }, r => {
          r.resume()
          r.on('end', () => res(r.statusCode ?? 0))
        })
        req.on('error', () => res(0))
        req.end()
      })
    expect(start('c1ea4ed0-1111-4000-8000-000000000001').status).toBe(0)
    expect(await poll(join(home, 'run', 'c1ea4ed0-111.sock'))).toBe(200)
    // another session's live socket is never replaced
    const live = join(home, 'run', 'a11ve000-222.sock')
    spawnSync('python3', ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(live)})`])
    start('a11ve000-2222-4000-8000-000000000002')
    const { lstatSync } = await import('node:fs')
    expect(lstatSync(live).isSymbolicLink()).toBe(false)
  })

  test('at startup the session-start hook waits a few seconds at most, and still reaches a bridge that comes up later', async () => {
    const { mkdtempSync, symlinkSync } = await import('node:fs')
    const run = mkdtempSync(join(dir, 'late-run-'))
    const t0 = Date.now()
    const r = spawnSync('sh', [join(DIST, 'hook.sh'), 'session-start'], {
      input: JSON.stringify({ session_id: 'b9c0ffee-3333-4000-8000-000000000003', hook_event_name: 'SessionStart', source: 'startup' }),
      env: { ...process.env, QUIETSYNC_HOME: home, QUIETSYNC_RUN_DIR: run },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(Date.now() - t0).toBeLessThan(4500)
    symlinkSync(sock, join(run, 'b9c0ffee-333.sock'))
    await until(async () => existsSync(join(home, 'run', 'b9c0ffee-333.sock')), 6000)
    expect(existsSync(join(home, 'run', 'b9c0ffee-333.sock'))).toBe(true)
  })

  test('a bridge that is there but does not answer means ask, not allow', () => {
    const dead = join(home, 'run', 'deadbeef0000.sock')
    spawnSync('python3', ['-c', `import socket; s=socket.socket(socket.AF_UNIX); s.bind(${JSON.stringify(dead)})`])
    const r = spawnSync('sh', [join(DIST, 'hook.sh'), 'pre-tool-use'], {
      input: JSON.stringify({ session_id: 'deadbeef0000-x', tool_name: 'Bash', tool_input: { command: 'ls' } }),
      env: { ...process.env, QUIETSYNC_HOME: home, QUIETSYNC_KEYSTORE: 'file' },
      encoding: 'utf8',
    })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask')
  })

  test('the session state file keeps no peer text', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const files = readdirSync(join(home, 'sessions'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(readFileSync(join(home, 'sessions', f), 'utf8')).not.toMatch(/deploy question|which bucket/)
  })

  test('a socket path that is too long on macOS leaves quietsync off with a clear reason, not a crash', async () => {
    if (process.platform !== 'darwin') return
    const longRun = join(dir, 'x'.repeat(220))
    const c2 = new Client({ name: 'test2', version: '0' })
    await c2.connect(
      new StdioClientTransport({
        command: 'node',
        args: [join(DIST, 'quietsync.mjs'), 'mcp'],
        env: { ...(process.env as Record<string, string>), QUIETSYNC_HOME: home, QUIETSYNC_RUN_DIR: longRun, CLAUDE_CODE_SESSION_ID: 'long-path-session', CLAUDE_CONFIG_DIR: join(dir, 'no-claude-login') },
        stderr: 'ignore',
      }),
    )
    const r = (await c2.callTool({ name: 'quietsync_status', arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean }
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toMatch(/control socket.*too long.*QUIETSYNC_RUN_DIR/)
    await c2.close()
  })

  test('message commands refuse to run under an agent, even in a fake terminal', () => {
    const command = ['node', join(DIST, 'quietsync.mjs'), 'messages'].map(part => `'${part.replaceAll("'", "'\\''")}'`).join(' ')
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', 'node', join(DIST, 'quietsync.mjs'), 'messages'] : ['-q', '-c', command, '/dev/null']
    const r = spawnSync('script', args, {
      env: { ...process.env, QUIETSYNC_HOME: home, CLAUDECODE: '1' },
      encoding: 'utf8',
      input: '',
      timeout: 15_000,
    })
    expect(`${r.stdout}${r.stderr}`).toContain('not one opened by an agent')
  })

  test('the hook is a no-op for sessions without quietsync', () => {
    const r = spawnSync('sh', [join(DIST, 'hook.sh'), 'pre-tool-use'], {
      input: JSON.stringify({ session_id: 'other-session-0000', tool_name: 'Bash', tool_input: { command: 'ls' } }),
      env: { ...process.env, QUIETSYNC_HOME: home, QUIETSYNC_KEYSTORE: 'file' },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
})
