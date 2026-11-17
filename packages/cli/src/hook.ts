#!/usr/bin/env node
// Small entrypoint for Claude Code hooks and the status line. These run on every
// tool call, so it avoids loading the MCP SDK, crypto, or the relay.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultHome, socketPathFor } from '../../core/src/paths.ts'
import { call, readStdin } from './ipc.ts'

const event = process.argv[2]
const raw = await readStdin()
let input: Record<string, any> = {}
try {
  input = JSON.parse(raw || '{}')
} catch {}
const sid = String(input.session_id ?? '')
const out = (x: unknown) => process.stdout.write(`${JSON.stringify(x)}\n`)

// The session's socket, or after /clear the one for the Claude Code process we share.
function socketFor(id: string): string {
  const direct = id ? socketPathFor(defaultHome(), id) : ''
  if (direct && (process.platform === 'win32' || existsSync(direct))) return direct
  const alias = join(process.env.QUIETSYNC_RUN_DIR || join(defaultHome(), 'run'), `p${process.env.QUIETSYNC_HOOK_PPID ?? process.ppid}.sock`)
  return existsSync(alias) ? alias : ''
}
const sock = socketFor(sid)

if (sock && event === 'pre-tool-use') {
  const d = await call(sock, '/hook/pre-tool-use', { tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd, source: 'hook' })
  // A bridge that's there but doesn't answer means nobody checked: ask the human.
  const decision = d ?? { decision: 'ask', reason: 'quietsync is running in this session but did not answer, so it could not check this call. Approve only if you expect it.' }
  if (decision.decision !== 'none') {
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.decision, permissionDecisionReason: decision.reason ?? '' } })
  }
} else if (sock && event === 'user-prompt-submit') {
  const r = await call(sock, '/hook/user-prompt-submit', { prompt: input.prompt, source: input.source ?? null, hook: true })
  if (r?.context || r?.message) out({ ...(r.context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.context } } : {}), ...(r.message ? { systemMessage: r.message } : {}) })
} else if (sock && event === 'session-start') {
  const r = await call(sock, '/hook/session-start', { session_id: sid, source: input.source })
  if (r?.context) out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r.context }, ...(r.message ? { systemMessage: r.message } : {}) })
} else if (event === 'session-start') {
  // This session's bridge isn't up yet: say what the others last saw waiting.
  try {
    process.stdout.write(readFileSync(join(process.env.QUIETSYNC_RUN_DIR || join(defaultHome(), 'run'), 'waiting.json'), 'utf8'))
  } catch {}
} else if (sock && event === 'stop') {
  const r = await call(sock, '/hook/stop', { active: !!input.stop_hook_active })
  if (r?.block) out({ decision: 'block', reason: r.block })
} else if (event === 'statusline') {
  const r = sid ? await call(sock, '/statusline', undefined, 800) : null
  const then = process.argv.indexOf('--then')
  let tail = ''
  if (then > 0 && process.argv[then + 1]) {
    tail = (spawnSync(process.argv[then + 1]!, { shell: true, input: raw, encoding: 'utf8' }).stdout ?? '').trimEnd()
  }
  process.stdout.write(`${[r?.line, tail].filter(Boolean).join('  ')}\n`)
}
