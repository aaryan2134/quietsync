#!/usr/bin/env node
import { resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLIENTS = ['codex', 'gemini', 'opencode']
const root = fileURLToPath(new URL('../', import.meta.url))

// These hosts use the existing messages-only surface until their tool gates
// have separate adapter tests. An MCP connection alone does not install hooks.
export function clientConfig(client, { identityDir, node = process.execPath, repo = root } = {}) {
  if (!CLIENTS.includes(client)) throw new Error(`client must be ${CLIENTS.join(', ')}`)
  if (!identityDir || !isAbsolute(identityDir)) throw new Error('identity-dir must be an absolute path')
  const args = [resolve(repo, 'plugins/claude-code/dist/quietsync.mjs'), 'mcp', '--surface', 'desktop']
  const env = {
    QUIETSYNC_HOME: identityDir,
    QUIETSYNC_AGENT: client,
    QUIETSYNC_LABEL: `${client}-messages`,
    QUIETSYNC_SURFACE: 'desktop',
  }
  if (client === 'codex') return { mcp_servers: { quietsync: { command: node, args, env, startup_timeout_sec: 15, tool_timeout_sec: 120 } } }
  if (client === 'gemini') return { mcpServers: { quietsync: { command: node, args, env, timeout: 120000, trust: false } } }
  return { $schema: 'https://opencode.ai/config.json', mcp: { quietsync: { type: 'local', command: [node, ...args], environment: env, enabled: true, timeout: 120000 } } }
}

export function codexToml(config) {
  const server = config.mcp_servers.quietsync
  return [
    '[mcp_servers.quietsync]',
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    `startup_timeout_sec = ${server.startup_timeout_sec}`,
    `tool_timeout_sec = ${server.tool_timeout_sec}`,
    '',
    '[mcp_servers.quietsync.env]',
    ...Object.entries(server.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    '',
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [client, ...options] = process.argv.slice(2)
    if (client === '--help' || !client) {
      console.log('Usage: node scripts/client-config.mjs <codex|gemini|opencode> --identity-dir /absolute/path [--json]')
      console.log('Prints an experimental messages-only MCP configuration. Review and merge it into your client configuration.')
      console.log('No settings, identities, plugins, approvals or permissions are changed.')
    } else {
      const index = options.indexOf('--identity-dir')
      const allowed = new Set(['--identity-dir', '--json'])
      for (let i = 0; i < options.length; i++) {
        if (!allowed.has(options[i])) throw new Error(`unknown option: ${options[i]}`)
        if (options[i] === '--identity-dir') i++
      }
      const config = clientConfig(client, { identityDir: index < 0 ? undefined : options[index + 1] })
      process.stdout.write(client === 'codex' && !options.includes('--json') ? codexToml(config) : `${JSON.stringify(config, null, 2)}\n`)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
