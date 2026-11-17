import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpProcess } from '../lib/mcp-process.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = join(root, 'plugins/claude-code/dist/quietsync.mjs')
const messagesOnly = ['quietsync_status', 'quietsync_message', 'quietsync_reply', 'quietsync_messages', 'quietsync_record', 'quietsync_setup', 'quietsync_join', 'quietsync_invite'].sort()

async function withBridge(surface, run) {
  const state = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'qs-probe-'))
  const client = new McpProcess(process.execPath, [bundle, 'mcp', ...(surface ? ['--surface', surface] : [])], {
    cwd: root,
    env: { QUIETSYNC_HOME: join(state, 'identity'), QUIETSYNC_RUN_DIR: join(state, 'run'), QUIETSYNC_KEYSTORE: 'file', QUIETSYNC_SURFACE: surface ?? '', QUIETSYNC_NOTIFY: 'off', CLAUDE_CONFIG_DIR: join(state, 'empty-claude'), QUIETSYNC_MANAGED_POLICY: join(state, 'no-policy.json') },
  })
  try { await run(client) } finally { await client.close(); rmSync(state, { recursive: true, force: true }) }
}

test('messages-only bundle initializes and reports that an unconfigured identity is not ready', async () => {
  await withBridge('desktop', async client => {
    const init = await client.initialize()
    assert.equal(init.serverInfo.name, 'quietsync')
    assert.match(init.instructions, /approves each send on a page/)
    const list = await client.request('tools/list')
    assert.deepEqual(list.tools.map(tool => tool.name).sort(), messagesOnly)
    const status = await client.request('tools/call', { name: 'quietsync_status', arguments: {} })
    assert.equal(status.isError, true)
    assert.match(status.content[0].text, /not running|control socket/)
  })
})

test('messages-only surface refuses direct calls to live-link and file tools', async () => {
  await withBridge('desktop', async client => {
    await client.initialize()
    for (const [name, args] of [['quietsync_connect', { peer: 'bob', topic: 'sample' }], ['quietsync_send_file', { link_id: 'sample', path: '/tmp/sample.txt' }]]) {
      const result = await client.request('tools/call', { name, arguments: args })
      assert.equal(result.isError, true)
      assert.match(result.content[0].text, /not available/)
    }
  })
})

test('hooked surface refuses a gated call when its approval hook never ran', async () => {
  await withBridge(null, async client => {
    await client.initialize()
    const result = await client.request('tools/call', { name: 'quietsync_message', arguments: { to: 'bob', subject: 'sample', text: 'sample' } })
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /didn't go through the approval hook/)
  })
})
