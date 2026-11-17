#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientConfig, CLIENTS } from './client-config.mjs'

function run(command, args, { cwd, env = {}, timeout = 15000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = signal => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-24000) })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-24000) })
    const timer = setTimeout(() => { timedOut = true; stop('SIGTERM') }, timeout)
    const watchdog = setTimeout(() => stop('SIGKILL'), timeout + 2000)
    child.on('error', error => { stderr += error.message })
    child.on('exit', () => stop('SIGTERM'))
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(watchdog)
      resolve({ code, signal, timedOut, stdout, stderr })
    })
  })
}

const selected = process.argv.slice(2)
const clients = selected.length ? selected : CLIENTS
if (clients.some(client => !CLIENTS.includes(client))) throw new Error(`choose ${CLIENTS.join(', ')}`)

for (const client of clients) {
  // Each host gets a disposable configuration and no QuietSync identity. Native
  // discovery is checked separately from a model-driven conversation.
  const temp = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'qs-client-'))
  try {
    const identityDir = join(temp, 'identity')
    const config = clientConfig(client, { identityDir })
    const env = { QUIETSYNC_KEYSTORE: 'file', QUIETSYNC_NOTIFY: 'off', CLAUDE_CONFIG_DIR: join(temp, 'empty-claude'), QUIETSYNC_MANAGED_POLICY: join(temp, 'no-policy.json') }
    const version = await run(client, ['--version'], { cwd: temp, timeout: 5000 })
    let probe
    if (client === 'codex') {
      const server = config.mcp_servers.quietsync
      const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', temp]
      for (const [key, value] of Object.entries(server)) {
        if (key === 'env') for (const [name, entry] of Object.entries(value)) args.push('-c', `mcp_servers.quietsync.env.${name}=${JSON.stringify(entry)}`)
        else args.push('-c', `mcp_servers.quietsync.${key}=${JSON.stringify(value)}`)
      }
      args.push('Call only the quietsync_status MCP tool and report whether this empty trial identity is configured. Do not read files or call other tools.')
      probe = await run(client, args, { cwd: temp, env, timeout: 20000 })
    } else if (client === 'gemini') {
      const home = join(temp, 'gemini-home')
      mkdirSync(join(home, '.gemini'), { recursive: true })
      writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ ...config, telemetry: { enabled: false }, security: { folderTrust: { enabled: false }, auth: { selectedType: 'gemini-api-key' } } }))
      writeFileSync(join(temp, 'system-settings.json'), '{}')
      // Gemini requires an auth method even for MCP discovery. A placeholder
      // selects API-key mode for this transport-only command; no model is called.
      probe = await run(client, ['mcp', 'list'], { cwd: temp, env: { ...env, GEMINI_API_KEY: 'quietsync-local-discovery-not-a-real-key', GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(temp, 'system-settings.json') }, timeout: 8000 })
    } else {
      const file = join(temp, 'opencode.json')
      writeFileSync(file, JSON.stringify(config))
      mkdirSync(join(temp, 'config'), { recursive: true })
      probe = await run(client, ['mcp', 'list', '--pure'], { cwd: temp, env: { ...env, OPENCODE_CONFIG: file, OPENCODE_CONFIG_DIR: join(temp, 'config'), XDG_CONFIG_HOME: join(temp, 'xdg-config'), XDG_DATA_HOME: join(temp, 'xdg-data'), XDG_CACHE_HOME: join(temp, 'xdg-cache'), XDG_STATE_HOME: join(temp, 'xdg-state') } })
    }
    const combined = `${probe.stdout}\n${probe.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
    const modelToolCall = client === 'codex' && probe.stdout.split('\n').some(line => {
      try {
        const event = JSON.parse(line)
        return event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.server === 'quietsync' && event.item.tool === 'quietsync_status'
      } catch { return false }
    })
    const connected = modelToolCall || (client === 'codex' ? /quietsync.*ready/i.test(combined) : /quietsync[^\n]*\bconnected\b/i.test(combined))
    console.log(JSON.stringify({ client, version: version.stdout.trim(), connected, modelToolCall, peerMessageRoundTrip: false, ...probe }))
    if (!connected) process.exitCode = 1
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
