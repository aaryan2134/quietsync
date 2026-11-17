import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENTS, clientConfig, codexToml } from '../client-config.mjs'

for (const client of CLIENTS) {
  test(`${client}: uses the messages-only surface and an explicit isolated identity`, () => {
    const config = clientConfig(client, { identityDir: '/tmp/quietsync test', node: '/tmp/node', repo: '/tmp/checkout with spaces' })
    const entry = config.mcp_servers?.quietsync ?? config.mcpServers?.quietsync ?? config.mcp?.quietsync
    const command = Array.isArray(entry.command) ? entry.command : [entry.command, ...entry.args]
    const env = entry.env ?? entry.environment
    assert.deepEqual(command, ['/tmp/node', '/tmp/checkout with spaces/plugins/claude-code/dist/quietsync.mjs', 'mcp', '--surface', 'desktop'])
    assert.equal(env.QUIETSYNC_HOME, '/tmp/quietsync test')
    assert.equal(env.QUIETSYNC_AGENT, client)
    assert.equal(env.QUIETSYNC_SURFACE, 'desktop')
    assert.equal(entry.trust ?? false, false)
  })
}

test('requires an absolute identity directory and a supported client', () => {
  assert.throws(() => clientConfig('codex'), /absolute/)
  assert.throws(() => clientConfig('gemini', { identityDir: 'relative' }), /absolute/)
  assert.throws(() => clientConfig('other', { identityDir: '/tmp/test' }), /client must be/)
})

test('Codex TOML escapes paths rather than interpolating shell commands', () => {
  const config = clientConfig('codex', { identityDir: '/tmp/a"b', repo: '/tmp/repo' })
  const toml = codexToml(config)
  assert.ok(toml.includes('QUIETSYNC_HOME = "/tmp/a\\"b"'))
  assert.ok(toml.includes('tool_timeout_sec = 120'))
  assert.ok(!toml.includes('bypass'))
})
