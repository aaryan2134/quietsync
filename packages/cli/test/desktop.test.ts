import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AgentNode, createIdentity, Policies, Store, type NodeEvent } from '@quietsync/core'
import { startRelay, type Relay } from '@quietsync/relay'

// The bridge as Claude Desktop chat runs it: no hooks, messages only, and
// every send approved on a page on 127.0.0.1 that only the browser is given.
const DIST = resolve(import.meta.dir, '../dist')
let relay: Relay
let dir: string
let client: Client
let bob: AgentNode
let urls: string

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function nextUrl(n: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const lines = existsSync(urls) ? readFileSync(urls, 'utf8').trim().split('\n').filter(Boolean) : []
    if (lines.length >= n) return lines[n - 1]!
    await sleep(50)
  }
  throw new Error('no approval page opened')
}
function http(url: string, opts: { method?: string; host?: string; origin?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(url)
  return new Promise(res => {
    const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: { host: opts.host ?? u.host, ...(opts.origin ? { origin: opts.origin } : {}) } }, r => {
      let b = ''
      r.on('data', c => (b += c))
      r.on('end', () => res({ status: r.statusCode ?? 0, body: b }))
    })
    req.end()
  })
}
function next(node: AgentNode, kind: NodeEvent['kind'], ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${kind}`)), ms)
    const off = node.on(e => {
      if (e.kind !== kind) return
      clearTimeout(t)
      off()
      resolve(e)
    })
  })
}

beforeAll(async () => {
  if (!existsSync(join(DIST, 'quietsync.mjs'))) throw new Error('run `bun run build` first')
  relay = startRelay({ port: 0 })
  dir = mkdtempSync(join(tmpdir(), 'al-desk-'))
  urls = join(dir, 'opened.txt')
  const aliceStore = new Store(join(dir, 'alice'))
  aliceStore.saveIdentity(createIdentity('alice'))
  aliceStore.setConfig({ relay: relay.url })
  const bobStore = new Store(join(dir, 'bob'))
  bobStore.saveIdentity(createIdentity('bob'))
  bobStore.setConfig({ relay: relay.url })
  bob = new AgentNode({ store: bobStore, session: { id: 'bob1', label: 'bob-repo', agent: 'test', device: 'mac' }, policies: new Policies(bobStore, { managed: null, org: null }) })
  await bob.start()
  const alice = new AgentNode({ store: aliceStore, session: { id: 'a0', label: 'setup', agent: 'test', device: 'mac' }, policies: new Policies(aliceStore, { managed: null, org: null }) })
  await alice.start()
  const { code, inviteId } = alice.createContactInvite()
  const paired = alice.waitForPairing(inviteId, 5000)
  await bob.pair(code, 5000)
  await paired
  // Something waiting before Claude Desktop starts.
  const got = next(alice, 'note')
  await bob.sendNote('alice', { kind: 'ask', subject: 'launch date', text: 'is the 14th still on?' })
  await got
  await alice.stop()

  client = new Client({ name: 'claude-desktop-test', version: '0' })
  await client.connect(
    new StdioClientTransport({
      command: 'node',
      args: [join(DIST, 'quietsync.mjs'), 'mcp', '--surface', 'desktop'],
      env: {
        ...(process.env as Record<string, string>),
        QUIETSYNC_HOME: join(dir, 'alice'),
        QUIETSYNC_KEYSTORE: 'file',
        QUIETSYNC_APPROVAL_OPEN: `file:${urls}`,
        QUIETSYNC_APPROVAL_WAIT_MS: '8000',
        QUIETSYNC_NOTIFY: 'off',
        CLAUDE_CONFIG_DIR: join(dir, 'no-claude-login'),
        QUIETSYNC_MANAGED_POLICY: join(dir, 'none.json'),
      },
      stderr: 'ignore',
    }),
  )
})

afterAll(async () => {
  await client?.close()
  await bob?.stop()
  relay?.stop()
  rmSync(dir, { recursive: true, force: true })
})

test('Claude Desktop: messages only, what is waiting is in the instructions, live links are refused', async () => {
  const names = (await client.listTools()).tools.map(t => t.name)
  expect(names).toContain('quietsync_message')
  expect(names).toContain('quietsync_reply')
  expect(names).not.toContain('quietsync_connect')
  expect(names).not.toContain('quietsync_send')
  const instr = client.getInstructions() ?? ''
  expect(instr).toContain('approves each send on a page')
  expect(instr).toContain('1 message(s)')
  expect(instr).toContain('from bob')
  expect(instr).not.toContain('launch date')
  const r = (await client.callTool({ name: 'quietsync_connect', arguments: { peer: 'bob', topic: 'x' } })) as any
  expect(r.isError).toBe(true)
  expect(r.content[0].text).toContain('not available in Claude Desktop')
})

test('a send waits for the approval page: the exact text is shown, approve sends it, decline does not, and other sites get nothing', async () => {
  const args = { to: 'bob', subject: 'launch date', text: 'yes, the 14th is still on' }
  const got = next(bob, 'note')
  const call = client.callTool({ name: 'quietsync_message', arguments: args }) as Promise<any>
  const url = await nextUrl(1)
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}\/a\/[A-Za-z0-9_-]+$/)
  const pageRes = await http(url)
  expect(pageRes.status).toBe(200)
  expect(pageRes.body).toContain('yes, the 14th is still on')
  expect(pageRes.body).toContain('to bob')
  const u = new URL(url)
  expect((await http(url, { host: 'evil.example:80' })).status).toBe(403)
  expect((await http(`${u.origin}/wrongsecret/a/${u.pathname.split('/').pop()}`)).status).toBe(404)
  expect((await http(`${url}/approve`, { method: 'POST', origin: 'https://evil.example' })).status).toBe(403)
  expect((await http(`${url}/approve`, { method: 'POST', origin: u.origin })).status).toBe(200)
  const r = await call
  expect(r.isError).toBe(false)
  expect((await got).subject).toBe('launch date')

  const second = client.callTool({ name: 'quietsync_message', arguments: { to: 'bob', subject: 'other', text: 'one more' } }) as Promise<any>
  const url2 = await nextUrl(2)
  expect((await http(`${url2}/decline`, { method: 'POST' })).status).toBe(200)
  const d = await second
  expect(d.isError).toBe(true)
  expect(d.content[0].text).toContain('declined')
  await sleep(200)
  expect(Object.values(bob.store.notes()).some(n => n.subject === 'other')).toBe(false)
})
