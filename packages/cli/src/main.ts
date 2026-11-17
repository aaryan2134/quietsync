#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import {
  AgentNode,
  checkRelayUrl,
  describeFeatures,
  detectOrg,
  FEATURE_HELP,
  isProfile,
  PROFILES,
  resolveFeatures,
  type Features,
  type FeatureSource,
  contactLabel,
  createIdentity,
  decodeInvite,
  describePolicy,
  fingerprint,
  loadManagedPolicy,
  loosens,
  managedPolicyPath,
  Policies,
  randomId,
  relLabel,
  resolvePolicy,
  ROLE_HELP,
  ROLES,
  safetyNumber,
  Store,
  validName,
  type PolicyFile,
  type PolicyPatch,
  type Role,
  checkDest,
  postRecord,
  RECORD_TYPES,
  type NoteView,
  type RecordDest,
  checkRule,
  keychainByDefault,
  systemKeyStore,
  journalKeygen,
  readJournal,
  isMode,
  MODE_HELP,
  MODES,
} from '@quietsync/core'
import { runBridge } from './bridge.ts'
import { call, readStdin } from './ipc.ts'
import { VERSION } from './version.ts'

const HELP = `quietsync ${VERSION}: connect agent sessions across people, teams and devices

setup
  quietsync setup [--name you] [--relay wss://…] [--join <code>] [--profile company|friends|startup]
                                                 one step: identity, relay, profile, Claude Code plugins
  quietsync uninstall [--purge]                  remove the plugins (and with --purge, ~/.quietsync)
  quietsync whoami | doctor

people (separate plans or orgs)
  quietsync invite [--ttl 24h] [--wait 5m]       one-time code to send someone
  quietsync pair <code>                          pair using a code someone sent you
  quietsync contacts                             list contacts and their roles
  quietsync block <peer> | unblock <peer>

profiles: company, friends, startup (asks you to confirm anything that loosens)
  quietsync profile                              the active switches and which layer set each one
  quietsync profile list                         what each profile turns on and off
  quietsync profile set <name> [key=value …]     your own choice, with optional switch overrides
  quietsync verify <peer>                        confirm a contact's safety number with them
  quietsync team profile <team> [<name> [key=value …]]   team admins: the profile your members run under

who can do what (asks you to confirm anything that loosens)
  quietsync mode <peer|team|external|team:NAME> ask|review|auto|trusted
                                                 how much flows without you approving it
  quietsync rules [list] | allow|ask|deny "fyi(team:payments)" | remove "<rule>"
                                                 per kind: fyi, ask, answer, request, send, receive; in: or out: for one direction
  quietsync roles                                what each role means
  quietsync role <peer|default|external|team|self|team:NAME> <role>
  quietsync policy show [peer]
  quietsync policy set <scope> key=value …       keys: role links send isolation secrets autoSendLimit maxMessageChars
  quietsync trust <peer> [--auto-accept on|off] [--send ask|auto]

teams (same plan or company)
  quietsync team create <name> [--handle h] [--profile company|friends|startup]
  quietsync team invite <team> [--ttl 7d] [--max N]
  quietsync team join <code> [--handle h]
  quietsync team members [team] | sync | remove <team> <member>

messages (wait for people who aren't online, with delivered, seen and answered)
  quietsync messages [--all]                     questions and messages, newest first
  quietsync messages show <id>                   read one, and its answer
  quietsync ask <peer> "<subject>" "<text>" [--ticket PAY-1] [--fyi]   send one yourself
  quietsync reply <id> "<text>"                  answer a question from your terminal
  quietsync dismiss <id>                         won't answer (they see "declined" if receipts are on)
  quietsync contact <peer> [--role "…"] [--note "…"]   contact book: what they do, what to ask them about
  quietsync records [list] | test <name> | post <id> <name> | remove <name>
  quietsync records add <name> slack|webhook --url <https…|env:VAR> [--auto]
  quietsync records add <name> jira --site <https…> --email <you@…> [--token env:VAR] [--auto]
  quietsync records add <name> email --to <address> | file --dir <folder> [--auto]

devices (same person, another machine)
  quietsync device add [--wait 10m]              on the machine that already has your identity
  quietsync device join <code> [--name <device>] on the new machine
  quietsync device revoke                        lost a device: new keys for you, contacts told (same as keys rotate)
  quietsync keys [keychain|file|rotate]          where your private keys live; new setups use the OS keychain

company records (admins)
  quietsync journal keygen --out <file>          key pair for the managed policy's sealed journal
  quietsync journal read <file|folder> --key <file> [--json]

claude desktop (chat, messages only: sends are approved on a page in your browser)
  quietsync desktop install [--print] | remove

running
  quietsync relay [--port 8787] [--host 127.0.0.1] [--db relay.sqlite] [--allow-keys file] [--trust-proxy]
  quietsync files                                files people sent you (saved unopened in the inbox folder)
  quietsync sessions | log [--n 30]
  quietsync mcp                                  the per-session bridge (started by the agent plugin)
  quietsync statusline [--then "<your statusline cmd>"]
`

function duration(s: string | undefined, fallback: number): number {
  if (!s) return fallback
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(s.trim())
  if (!m) throw new Error(`bad duration "${s}", use e.g. 30m, 24h, 7d`)
  return Number(m[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[m[2] as 's' | 'm' | 'h' | 'd']
}

// An agent's shell can fake a terminal, so commands that read or send someone's
// messages, or change the contact book or records, also refuse to run under Claude Code.
function underAgent(): boolean {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return true
  if (process.platform === 'win32') return false
  let pid = process.ppid
  for (let i = 0; i < 40 && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8' })
    const m = /^\s*(\d+)\s+(.*)$/.exec((r.stdout ?? '').trim())
    if (!m) break
    if (/(^|\/)claude(\s|$)|@anthropic-ai\/claude-code/.test(m[2]!)) return true
    pid = Number(m[1])
  }
  return false
}

const HUMAN_ONLY = 'this needs a human at their own terminal, not one opened by an agent'

async function confirm(question: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('this needs a human at an interactive terminal')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question}\nType "${expected}" to confirm: `)
  rl.close()
  return answer.trim() === expected
}

async function withNode<T>(store: Store, fn: (node: AgentNode) => Promise<T>, relayUrl?: string): Promise<T> {
  const node = new AgentNode({ store, relayUrl, session: { id: `cli-${randomId(6)}`, label: 'cli', agent: 'cli', device: store.config().deviceName } })
  await node.start()
  try {
    return await fn(node)
  } finally {
    await node.stop()
  }
}

function offlineNode(store: Store): AgentNode {
  return new AgentNode({ store, session: { id: 'cli', label: 'cli', agent: 'cli', device: store.config().deviceName } })
}

function contactRows(store: Store): string[] {
  const all = store.contacts()
  const teams = store.teams()
  const node = store.hasIdentity() ? offlineNode(store) : null
  return Object.values(all).map(c => {
    const p = node?.policyFor(c.id)
    const flags = [c.blocked && 'blocked', c.verified && 'verified', p?.blockedBy && 'not allowed by profile', p && !p.blockedBy && `mode ${p.mode}${p.maxMode !== 'trusted' ? ` (up to ${p.maxMode})` : ''}`, p && !p.blockedBy && p.role !== 'peer' && p.role, p?.links === 'auto' && 'auto-accept', p?.send === 'auto' && 'AUTO-SEND'].filter(Boolean)
    return `  ${contactLabel(c, all, teams).padEnd(22)} ${relLabel(c.rel).padEnd(12)} ${fingerprint(c.id)}${flags.length ? `  [${flags.join(', ')}]` : ''}`
  })
}

function sh(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

function defaultName(): string {
  const git = sh('git', ['config', '--global', 'user.email']).out.split('@')[0] ?? ''
  const base = (git || userInfo().username || 'me').toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '')
  return base.slice(0, 32) || 'me'
}

// The repo checkout this CLI runs from, when it does (dev installs and the
// plugin's own copy both sit two levels under it).
function localMarketplace(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const up of ['../../..', '../..', '..']) {
    const root = resolve(here, up)
    if (existsSync(join(root, '.claude-plugin', 'marketplace.json'))) return root
  }
  return null
}

function parseValue(v: string): unknown {
  if (v === 'true' || v === 'false') return v === 'true'
  if (/^\d+$/.test(v)) return Number(v)
  return v
}

function scopeRef(store: Store, scope: string): { path: (f: PolicyFile) => PolicyPatch; label: string } {
  if (scope === 'default' || scope === 'external' || scope === 'team' || scope === 'self') {
    return { path: f => (f[scope] ??= {}), label: scope }
  }
  if (scope.startsWith('team:')) {
    const name = scope.slice(5)
    return { path: f => ((f.teams ??= {})[name] ??= {}), label: `team ${name}` }
  }
  const c = offlineNode(store).resolvePeer(scope)
  if (!c || c.rel === 'self') throw new Error(`no contact "${scope}" (scopes: default, external, team, self, team:NAME, or a contact)`)
  return { path: f => ((f.contacts ??= {})[c.id] ??= {}), label: c.name }
}

// A lost or retired device: new keys, every contact told under the old ones.
async function rotateKeys(store: Store): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || underAgent()) return (console.error(HUMAN_ONLY), 1)
  console.log(
    '\n  This makes new keys for you and tells every contact. Anything with the old keys, like a lost laptop,\n' +
      '  stops getting new messages. Afterwards: restart your Claude Code sessions, add your other devices again\n' +
      '  (`quietsync device add`), and ask your team admins for new team codes. Contacts will see your safety number change.\n',
  )
  if (!(await confirm('Rotate your keys?', 'rotate'))) return (console.log('not changed'), 1)
  const r = await withNode(store, node => node.rotateKeys({ keychain: store.keysInKeychain() }))
  console.log(`new key ${fingerprint(r.card.sign)}. Told ${r.told.length} contact(s)${r.told.length ? `: ${r.told.join(', ')}` : ''}.${r.failed.length ? ` Couldn't reach ${r.failed.join(', ')}; pair with them again.` : ''}`)
  return 0
}

async function applyPolicy(store: Store, scope: string, patch: PolicyPatch): Promise<number> {
  const ref = scopeRef(store, scope)
  return applyFileChange(store, ref.label, f => void Object.assign(ref.path(f), patch), [
    ...(patch.send === 'auto' ? ["your agent's replies go out without you seeing them first"] : []),
    ...(patch.links === 'auto' ? ['link requests get accepted without asking you'] : []),
    ...(patch.mode ? [`${patch.mode} mode: ${MODE_HELP[patch.mode]}`] : []),
  ])
}

// What the probes can miss: a mode raised for a team or contact nobody is in yet,
// or an allow rule for one.
function fileLoosens(before: PolicyFile, after: PolicyFile): boolean {
  const added = (after.rules?.allow ?? []).filter(r => !(before.rules?.allow ?? []).includes(r))
  if (added.length) return true
  const removed = (k: 'ask' | 'deny') => (before.rules?.[k] ?? []).some(r => !(after.rules?.[k] ?? []).includes(r))
  if (removed('ask') || removed('deny')) return true
  const modes = (f: PolicyFile) => {
    const out: Record<string, string | undefined> = {}
    for (const k of ['default', 'external', 'team', 'self'] as const) out[k] = f[k]?.mode
    for (const [n, p] of Object.entries(f.teams ?? {})) out[`teams.${n}`] = p.mode
    for (const [n, p] of Object.entries(f.contacts ?? {})) out[`contacts.${n}`] = p.mode
    return out
  }
  const mb = modes(before)
  const rank = (m: string | undefined) => (isMode(m) ? MODES.indexOf(m) : -1)
  return Object.entries(modes(after)).some(([k, m]) => isMode(m) && rank(m) > rank(mb[k]))
}

// Any change to policy.json: loosening anything needs the human to type a confirmation.
async function applyFileChange(store: Store, label: string, mutate: (f: PolicyFile) => void, notes: string[] = []): Promise<number> {
  const before = store.policyFile()
  const after: PolicyFile = JSON.parse(JSON.stringify(before))
  mutate(after)
  const managed = loadManagedPolicy()
  const probe = (f: PolicyFile) =>
    (['external', 'team', 'self'] as const).map(rel => resolvePolicy(f, managed, { id: '', rel, teams: [] }))
  const contactProbe = (f: PolicyFile) =>
    Object.values(store.contacts()).map(c => resolvePolicy(f, managed, { id: c.id, rel: c.rel, teams: c.teams.map(t => ({ id: t, name: store.teams()[t]?.card.name ?? t })) }))
  const a = [...probe(before), ...contactProbe(before)]
  const b = [...probe(after), ...contactProbe(after)]
  if (a.some((p, i) => loosens(p, b[i]!)) || fileLoosens(before, after)) {
    console.log(
      `\n  WARNING: this loosens what agents can do for ${label}, in every future session.\n` +
        notes.map(n => `  - ${n}\n`).join('') +
        '  A prompt-injected or compromised peer could then pull answers from your agent unseen.\n',
    )
    if (!(await confirm('Apply it?', label))) {
      console.log('not changed')
      return 1
    }
  }
  store.updatePolicyFile(mutate)
  console.log(`${label}: updated\nrunning sessions pick up tightening right away and loosening when they restart`)
  return 0
}

function featureOverrides(pairs: string[]): Partial<Features> {
  const out: Record<string, unknown> = {}
  for (const kv of pairs) {
    const [k, v] = kv.split('=')
    if (!k || v === undefined || !(k in FEATURE_HELP)) throw new Error(`unknown switch "${kv}". Switches: ${Object.keys(FEATURE_HELP).join(', ')}`)
    out[k] = parseValue(v)
  }
  return out as Partial<Features>
}

const LOOSER: Array<keyof Features> = ['external', 'autoSend', 'autoAccept', 'secretsOverride', 'devices', 'shareDevice', 'shareSession', 'receipts', 'files', 'messages', 'records']
const STRICTER: Array<keyof Features> = ['orgOnly', 'requireVerified']

function loosenedFeatures(before: Features, after: Features): string[] {
  return [
    ...LOOSER.filter(k => !before[k] && after[k]).map(k => `${k}: ${FEATURE_HELP[k]}`),
    ...STRICTER.filter(k => before[k] && !after[k]).map(k => `${k} off: ${FEATURE_HELP[k]}`),
  ]
}

async function loadRelay(): Promise<typeof import('@quietsync/relay')> {
  if (!process.versions.bun) throw new Error('the relay runs on Bun (https://bun.sh), or use the Docker image in packages/relay')
  try {
    return await import(new URL('./relay.mjs', import.meta.url).href)
  } catch {
    return await import('@quietsync/relay')
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  const { values: o, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: {
      name: { type: 'string' },
      relay: { type: 'string' },
      join: { type: 'string' },
      device: { type: 'string' },
      ttl: { type: 'string' },
      wait: { type: 'string' },
      handle: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      db: { type: 'string' },
      n: { type: 'string' },
      max: { type: 'string' },
      then: { type: 'string' },
      send: { type: 'string' },
      marketplace: { type: 'string' },
      profile: { type: 'string' },
      'allow-keys': { type: 'string' },
      'auto-accept': { type: 'string' },
      'trust-proxy': { type: 'boolean' },
      'public-host': { type: 'string' },
      'no-plugins': { type: 'boolean' },
      'no-keychain': { type: 'boolean' },
      surface: { type: 'string' },
      print: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      purge: { type: 'boolean' },
      ticket: { type: 'string' },
      out: { type: 'string' },
      key: { type: 'string' },
      json: { type: 'boolean' },
      fyi: { type: 'boolean' },
      all: { type: 'boolean' },
      role: { type: 'string' },
      note: { type: 'string' },
      url: { type: 'string' },
      site: { type: 'string' },
      email: { type: 'string' },
      token: { type: 'string' },
      to: { type: 'string' },
      dir: { type: 'string' },
      auto: { type: 'boolean' },
    },
  }) as { values: Record<string, any>; positionals: string[] }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return 0
  }
  if (cmd === '--version' || cmd === 'version') {
    console.log(VERSION)
    return 0
  }

  if (cmd === 'mcp') {
    if (o.surface === 'desktop') process.env.QUIETSYNC_SURFACE = 'desktop'
    await runBridge()
    return -1
  }

  if (cmd === 'relay') {
    const { startRelay } = await loadRelay()
    const keysFile = o['allow-keys'] ?? process.env.QUIETSYNC_RELAY_ALLOW_KEYS
    const readKeys = () => (keysFile ? readFileSync(keysFile, 'utf8').split(/\s+/).filter(k => /^[A-Za-z0-9_-]{43}$/.test(k)) : undefined)
    const relay = startRelay({
      port: Number(o.port ?? process.env.PORT ?? 8787),
      hostname: o.host ?? process.env.HOST ?? '127.0.0.1',
      dbPath: o.db ?? process.env.QUIETSYNC_RELAY_DB,
      allowKeys: readKeys(),
      trustProxy: !!o['trust-proxy'] || process.env.QUIETSYNC_TRUST_PROXY === '1',
      publicHost: o['public-host'] ?? process.env.QUIETSYNC_PUBLIC_HOST,
      log: m => console.log(m),
    })
    if (keysFile) {
      console.log(`members-only: ${readKeys()?.length ?? 0} keys from ${keysFile} (plus admitted team members). SIGHUP reloads.`)
      process.on('SIGHUP', () => relay.allow(readKeys() ?? []))
    }
    process.on('SIGINT', () => {
      relay.stop()
      process.exit(0)
    })
    process.on('SIGTERM', () => {
      relay.stop()
      process.exit(0)
    })
    return -1
  }

  const store = new Store()

  if (cmd === 'statusline') {
    const raw = await readStdin()
    let input: Record<string, any> = {}
    try {
      input = JSON.parse(raw || '{}')
    } catch {}
    const r = input.session_id ? await call(store.socketPath(String(input.session_id)), '/statusline', undefined, 800) : null
    let tail = ''
    if (o.then) tail = (spawnSync(o.then, { shell: true, input: raw, encoding: 'utf8' }).stdout ?? '').trimEnd()
    console.log([r?.line, tail].filter(Boolean).join('  '))
    return 0
  }

  if (cmd === 'setup' || cmd === 'init') {
    const dry = !!o['dry-run']
    const steps: string[] = []
    const relayUrl: string | undefined = o.relay ?? (o.join ? decodeInvite(o.join).r : undefined)
    if (relayUrl) {
      const problem = checkRelayUrl(relayUrl, { allowInsecure: store.policyFile().allowInsecureRelays === true })
      if (problem) throw new Error(problem)
    }
    let joinKind: string | null = o.join ? decodeInvite(o.join).k : null
    if (!store.hasIdentity() && joinKind !== 'device') {
      const name = String(o.name ?? pos[0] ?? defaultName()).toLowerCase()
      if (!validName(name)) throw new Error(`"${name}" isn't a valid name: lowercase letters, digits, . _ - (max 32)`)
      steps.push(`create identity "${name}" in ${store.home}`)
      const kc = !o['no-keychain'] && keychainByDefault()
      steps.push(kc ? `private keys in the ${systemKeyStore()!.kind}` : `private keys in ${store.path('identity.json')}, owner-only`)
      if (!dry) store.saveIdentity(createIdentity(name), { keychain: kc })
    } else if (store.hasIdentity()) {
      const id = store.requireIdentity()
      steps.push(`identity ${id.name} (${fingerprint(id.card.sign)}) already here, kept`)
    }
    if (relayUrl && joinKind !== 'device' && store.config().relay !== relayUrl) {
      if (store.config().relay && o.join && !o.relay) steps.push(`keep relay ${store.config().relay} (the code's relay ${relayUrl} is reached directly)`)
      else {
        steps.push(`set relay ${relayUrl}`)
        if (!dry) store.setConfig({ relay: relayUrl })
      }
    }
    if (o.device && !dry) store.setConfig({ deviceName: o.device })
    if (o.profile) {
      if (!isProfile(o.profile) || o.profile === 'default') throw new Error('--profile must be company, friends or startup')
      steps.push(`profile ${o.profile}: ${PROFILES[o.profile].summary}`)
      if (!dry) store.updatePolicyFile(f => ({ ...f, profile: o.profile }))
    }
    const org = detectOrg()
    if (org) steps.push(`signed into the ${org.name} plan: you can only link with colleagues in your org's quietsync teams`)
    if (o.join && !dry) {
      if (joinKind === 'device') {
        const id = await AgentNode.joinDevice(store, o.join, o.device ?? store.config().deviceName)
        if (!o['no-keychain'] && keychainByDefault()) store.saveIdentity(id, { keychain: true })
        steps.push(`copied identity ${id.name} from your other machine`)
      } else if (joinKind === 'contact') {
        await withNode(store, async node => {
          const r = await node.pair(o.join, 30_000)
          steps.push(r.contact ? `paired with ${r.contact.name}, safety number ${r.safety}` : `pairing request queued, safety number ${r.safety}`)
        })
      } else {
        await withNode(store, async node => {
          const r = await node.teamJoin(o.join, o.handle)
          steps.push(r.admitted ? `joined team ${r.team.card.name}` : `asked to join ${r.team.card.name}, waiting for its admin to admit you`)
        })
      }
    }
    if (!o['no-plugins']) {
      const claude = sh('claude', ['--version'])
      if (!claude.ok) steps.push("Claude Code CLI not found, skipped plugins. Install them later with: claude plugin install quietsync-ui@quietsync")
      else {
        const source = o.marketplace ?? process.env.QUIETSYNC_MARKETPLACE ?? localMarketplace() ?? 'aaryan2134/quietsync'
        const installed = sh('claude', ['plugin', 'list', '--json']).out
        const has = (id: string) => installed.includes(`"${id}"`)
        if (!has('quietsync@quietsync') || !has('quietsync-ui@quietsync')) {
          steps.push(`claude plugin marketplace add ${source}`)
          if (!dry) {
            const m = sh('claude', ['plugin', 'marketplace', 'add', source])
            if (!m.ok && !/already/i.test(m.out)) throw new Error(`marketplace add failed: ${m.out}`)
          }
          for (const id of ['quietsync@quietsync', 'quietsync-ui@quietsync']) {
            if (has(id)) continue
            steps.push(`claude plugin install ${id}`)
            if (!dry) {
              const r = sh('claude', ['plugin', 'install', id])
              if (!r.ok) throw new Error(`install ${id} failed: ${r.out}`)
            }
          }
        } else steps.push('Claude Code plugins already installed')
      }
    }
    console.log(`${dry ? 'would do' : 'done'}:\n${steps.map(s => `  - ${s}`).join('\n')}`)
    if (!dry) {
      if (!store.config().relay) console.log('\nno relay yet: run `quietsync setup --relay wss://…` (ask whoever runs your team relay)')
      console.log(`\nIn Claude Code, run /reload-plugins (or start a new session). Changed files: only ${store.home} and the Claude Code plugin cache.`)
      console.log(
        '\nBefore you use it: quietsync lowers the risk of letting other people\'s agents talk to yours; it does not remove it.\n' +
          'You approve every message that leaves, so read each dialog. Peer text is untrusted. This is early, unaudited\n' +
          'software: keep regulated or high-stakes data out of it. Read docs/safety.md.',
      )
    }
    return 0
  }

  if (cmd === 'uninstall') {
    for (const id of ['quietsync-ui@quietsync', 'quietsync@quietsync']) {
      const r = sh('claude', ['plugin', 'uninstall', id])
      console.log(`${r.ok ? 'removed' : 'skipped'} ${id}`)
    }
    const m = sh('claude', ['plugin', 'marketplace', 'remove', 'quietsync'])
    console.log(`${m.ok ? 'removed' : 'skipped'} marketplace quietsync`)
    if (o.purge) {
      if (!(await confirm(`\nDelete ${store.home}? This destroys your quietsync identity, contacts and audit log.`, 'delete'))) return 1
      rmSync(store.home, { recursive: true, force: true })
      console.log(`deleted ${store.home}`)
    } else console.log(`kept ${store.home} (your identity and contacts). Add --purge to delete it.`)
    return 0
  }

  if (cmd === 'whoami') {
    const id = store.requireIdentity()
    const c = store.config()
    console.log(`${id.name}  key ${fingerprint(id.card.sign)}\ndevice ${c.deviceName}\nrelay ${c.relay ?? 'none'}\nhome ${store.home}`)
    return 0
  }

  if (cmd === 'invite' || cmd === 'pair') {
    const no = offlineNode(store).externalAllowed()
    if (no) return (console.error(`quietsync: ${no}. Ask your admin for a team code instead.`), 1)
  }

  if (cmd === 'invite') {
    const ttl = duration(o.ttl, 24 * 3.6e6)
    const wait = duration(o.wait, 5 * 6e4)
    return withNode(store, async node => {
      const { code, inviteId } = node.createContactInvite(ttl)
      console.log(`send this code to the other person (works once, expires in ${o.ttl ?? '24h'}):\n\n${code}\n`)
      console.log('they run: quietsync pair <code>   (or paste it to their Claude)')
      console.log(`waiting up to ${Math.round(wait / 6e4)}m for them (ctrl-c is fine, any quietsync session finishes the pairing later)...`)
      const c = await node.waitForPairing(inviteId, wait)
      if (!c) return 0
      console.log(`paired with ${c.name} (${fingerprint(c.id)})`)
      console.log(`safety number: ${safetyNumber(node.identity.card.sign, c.id)}  (read it to each other to be sure)`)
      return 0
    })
  }

  if (cmd === 'pair') {
    const code = pos[0]
    if (!code) return (console.error('usage: quietsync pair <code>'), 1)
    const inv = decodeInvite(code)
    if (!store.config().relay) store.setConfig({ relay: inv.r })
    return withNode(store, async node => {
      const r = await node.pair(code, duration(o.wait, 60_000))
      if (r.contact) console.log(`paired with ${r.contact.name} (${fingerprint(r.contact.id)})`)
      else console.log(`request sent to ${'p' in inv ? inv.p.name : 'them'}, they look offline. It completes when one of their quietsync sessions comes online.`)
      console.log(`safety number: ${r.safety}  (read it to each other to be sure)`)
      return 0
    })
  }

  if (cmd === 'messages' || cmd === 'ask' || cmd === 'reply' || cmd === 'dismiss') {
    if (!store.hasIdentity()) return (console.error('set up first: quietsync setup'), 1)
    // Reading someone's message or sending one is a person's job, not the agent's shell.
    if (!process.stdin.isTTY || !process.stdout.isTTY || underAgent()) return (console.error(HUMAN_ONLY), 1)
    const when = (t: number) => {
      const d = new Date(t)
      const p = (x: number) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    const line = (n: NoteView) => {
      const what = n.kind === 'ask' ? 'question' : n.kind === 'request' ? 'request' : n.kind === 'reply' ? 'answer' : 'note'
      const state = n.applied && n.state === 'new' ? 'with your agent' : n.dir === 'out' && (n.kind === 'ask' || n.kind === 'request') && n.state === 'answered' && !n.continued ? 'answered, not picked up' : n.state
      const subject = n.subject.length > 44 ? `${n.subject.slice(0, 43)}…` : n.subject
      return `  ${n.id}  ${when(n.at)}  ${n.dir === 'in' ? 'from' : 'to  '} ${n.peer.label.padEnd(12)} ${what.padEnd(8)} ${state.padEnd(10)} "${subject}"`
    }
    if (cmd === 'messages' && pos[0] === 'show') {
      const node = offlineNode(store)
      const n = node.findNote(pos[1] ?? '')
      if (!n) return (console.error(`no message "${pos[1]}"`), 1)
      const v = node.noteView(n)
      console.log(`${v.dir === 'in' ? 'from' : 'to'} ${v.peer.label}, ${v.kind}, ${v.state}${v.ticket ? `, ${v.ticket}` : ''}\nsubject: ${v.subject}\n\n${v.text}`)
      if (v.flags.length) console.log(`\n! tripped injection checks: ${v.flags.join(', ')}`)
      if (v.answer) console.log(`\n--- answer, ${new Date(v.answer.at).toISOString().slice(0, 16).replace('T', ' ')}:\n${v.answer.text}`)
      if (n.dir === 'in') await withNode(store, async nd => nd.markNotesSeen([n.key]))
      return 0
    }
    if (cmd === 'messages') {
      // Briefly online, so anything the relay held for you comes in.
      const views = await withNode(store, async node => {
        await new Promise(r => setTimeout(r, 1500))
        return node.notesView()
      })
      // Threads, not their parts: an answer shows as the state of its question. --all shows everything.
      const week = Date.now() - 7 * 24 * 3600_000
      const shown = o.all ? views : views.filter(n => n.kind !== 'reply' && !['dismissed', 'declined', 'expired'].includes(n.state) && (n.at > week || ['new', 'queued', 'sent', 'delivered'].includes(n.state)))
      console.log(shown.length ? shown.slice(0, 50).map(line).join('\n') : 'no messages this week (--all for everything)')
      return 0
    }
    if (cmd === 'ask') {
      const [to, subject, ...rest] = pos
      const body = rest.join(' ').trim()
      if (!to || !subject || !body) return (console.error('usage: quietsync ask <peer> "<subject>" "<text>"'), 1)
      const preview = offlineNode(store).prepare([{ peerId: offlineNode(store).resolvePeer(to)?.id ?? '' }], body)
      if (preview.blocked) return (console.error(`blocked: ${preview.blocked}`), 1)
      if (!(await confirm(`to ${to}, subject "${subject}"${preview.redacted ? ` (${preview.redacted} secret(s) redacted)` : ''}:\n${preview.text}`, 'send'))) return (console.error('not sent'), 1)
      const r = await withNode(store, node => node.sendNote(to, { kind: o.fyi ? 'note' : 'ask', subject, text: body, ticket: o.ticket }))
      console.log(`${r.note.id}: ${r.queued ? `queued for ${r.note.peer.label} (offline, kept up to 7 days)` : `sent to ${r.note.peer.label}`}${r.redacted ? `, ${r.redacted} secret(s) redacted` : ''}`)
      return 0
    }
    if (cmd === 'reply') {
      const [id, ...rest] = pos
      const body = rest.join(' ').trim()
      if (!id || !body) return (console.error('usage: quietsync reply <id> "<text>"'), 1)
      if (!(await confirm(`answer to ${id}:\n${body}`, 'send'))) return (console.error('not sent'), 1)
      const r = await withNode(store, node => node.replyNote(id, body))
      console.log(`answer ${r.queued ? `queued for ${r.note.peer.label}` : `sent to ${r.note.peer.label}`}${r.redacted ? `, ${r.redacted} secret(s) redacted` : ''}`)
      return 0
    }
    const done = await withNode(store, node => node.dismissNote(pos[0] ?? ''))
    console.log(done ? 'dismissed' : 'nothing to dismiss: it was already answered or dismissed')
    return 0
  }

  // Contact book entries steer who the agent asks, so only a person at a terminal sets them.
  if (cmd === 'contact') {
    if (!process.stdin.isTTY || !process.stdout.isTTY || underAgent()) return (console.error(HUMAN_ONLY), 1)
    const c = offlineNode(store).resolvePeer(pos[0] ?? '')
    if (!c || c.rel === 'self') return (console.error(`no contact "${pos[0]}"`), 1)
    if (o.role === undefined && o.note === undefined) {
      console.log(`${c.name}: role ${c.role ?? '(none)'}, ask about: ${c.note ?? '(nothing noted)'}`)
      return 0
    }
    const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    store.updateContacts(all => {
      const x = all[c.id]!
      if (o.role !== undefined) x.role = clean(String(o.role)).slice(0, 40) || undefined
      if (o.note !== undefined) x.note = clean(String(o.note)).slice(0, 160) || undefined
    })
    console.log(`updated ${c.name}`)
    return 0
  }

  if (cmd === 'records') {
    const sub = pos[0] ?? 'list'
    const all = store.records()
    if (sub === 'list') {
      const rows = Object.entries(all).map(([k, d]) => `  ${k.padEnd(14)} ${d.type.padEnd(8)} ${d.auto ? 'automatic' : 'on request'}  ${d.type === 'email' ? d.to : d.type === 'file' ? d.dir : d.type === 'jira' ? d.site : '(url hidden)'}`)
      console.log(rows.length ? rows.join('\n') : 'no record destinations yet: quietsync records add <name> slack --url <webhook>')
      return 0
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY || underAgent()) return (console.error(HUMAN_ONLY), 1)
    const name = pos[1] ?? ''
    if (sub === 'add') {
      const type = pos[2] as RecordDest['type']
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || !RECORD_TYPES.includes(type)) return (console.error(`usage: quietsync records add <name> ${RECORD_TYPES.join('|')} …`), 1)
      const ask = async (q: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        const a = await rl.question(q)
        rl.close()
        return a.trim()
      }
      const auto = !!o.auto
      let d: RecordDest
      if (type === 'slack' || type === 'webhook') d = { type, url: o.url ?? (await ask(`${type === 'slack' ? 'Slack incoming webhook' : 'webhook'} URL (or env:VAR): `)), auto }
      else if (type === 'jira') d = { type, site: o.site ?? '', email: o.email ?? '', token: o.token ?? (await ask('Jira API token (or env:VAR): ')), auto }
      else if (type === 'email') d = { type, to: o.to ?? '', auto }
      else d = { type, dir: o.dir ?? '', auto }
      const problem = checkDest(d)
      if (problem) return (console.error(`${name}: ${problem}`), 1)
      store.updateRecords(r => {
        r[name] = d
      })
      console.log(`added ${name} (${type}${auto ? ', posts every answered question automatically' : ', posts when you or your agent ask'}). Try it: quietsync records test ${name}`)
      return 0
    }
    if (sub === 'remove') {
      if (!all[name]) return (console.error(`no destination "${name}"`), 1)
      store.updateRecords(r => {
        delete r[name]
      })
      console.log(`removed ${name}`)
      return 0
    }
    if (sub === 'test' || sub === 'post') {
      const target = sub === 'test' ? name : (pos[2] ?? '')
      const d = all[target]
      if (!d) return (console.error(`no destination "${target}"`), 1)
      const node = offlineNode(store)
      const now = Date.now()
      const t = sub === 'test' ? { subject: 'QuietSync test record', ask: { by: node.identity.name, text: 'If you can read this, records work.', at: now } } : node.thread(name).thread
      const opener = (u: string) => spawnSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open', process.platform === 'win32' ? ['/c', 'start', '', u] : [u])
      const r = await postRecord(target, d, t, node.policies.dlp(), { open: opener })
      if (r.ok && sub === 'post') node.markRecorded(node.thread(name).key, target)
      console.log(r.detail)
      return r.ok ? 0 : 1
    }
    console.error('usage: quietsync records [list] | add | remove | test | post')
    return 1
  }

  if (cmd === 'contacts') {
    const rows = contactRows(store)
    console.log(rows.length ? rows.join('\n') : 'no contacts yet: `quietsync invite` or `quietsync team join`')
    return 0
  }

  if (cmd === 'profile') {
    const pol = new Policies(store)
    if (!pos[0] || pos[0] === 'show') {
      const r = pol.features()
      console.log(`active profile: ${r.profile}${pol.org ? `   (signed into ${pol.org.name}, ${pol.org.plan})` : ''}\n`)
      console.log(`${'switch'.padEnd(16)} ${'value'.padEnd(9)} ${'set by'.padEnd(34)} meaning`)
      for (const line of describeFeatures(r)) console.log(line)
      return 0
    }
    if (pos[0] === 'list') {
      for (const [name, p] of Object.entries(PROFILES)) {
        console.log(`${name}  (security ${p.security}, privacy ${p.privacy})\n  ${p.summary}`)
        const off = (Object.keys(p.features) as Array<keyof Features>).filter(k => p.features[k] === false).join(', ')
        if (off) console.log(`  off: ${off}`)
        console.log(`  audit: ${p.features.audit}, ${p.features.auditDays} days${p.features.orgOnly ? ', org-only' : ''}${p.features.requireVerified ? ', verified contacts only' : ''}\n`)
      }
      return 0
    }
    if (pos[0] === 'set') {
      const name = pos[1]
      if (!isProfile(name)) return (console.error('usage: quietsync profile set <company|friends|startup|default> [key=value …]'), 1)
      const features = featureOverrides(pos.slice(2))
      const swap = (src: FeatureSource[]) => [...src.filter(x => x.kind !== 'you'), { kind: 'you' as const, label: 'you', choice: { profile: name, features } }]
      const before = pol.features().features
      const after = resolveFeatures(swap(pol.sources())).features
      const looser = loosenedFeatures(before, after)
      if (looser.length) {
        console.log(`\n  This turns on:\n${looser.map(l => `  - ${l}`).join('\n')}\n`)
        if (!(await confirm('Apply it?', name))) return (console.log('not changed'), 1)
      }
      store.updatePolicyFile(f => ({ ...f, profile: name, features: Object.keys(features).length ? features : undefined }))
      console.log(`profile ${name}. Running sessions pick up tightening now and loosening when they restart.`)
      const blocked = (Object.keys(features) as Array<keyof Features>).filter(k => after[k] !== features[k])
      if (blocked.length) console.log(`note: ${blocked.join(', ')} stay as they are because of ${blocked.map(k => resolveFeatures(swap(pol.sources())).from[k]).join(', ')}`)
      return 0
    }
    return (console.error('usage: quietsync profile [show|list|set <name> [key=value …]]'), 1)
  }

  if (cmd === 'verify') {
    const node = offlineNode(store)
    const c = node.resolvePeer(pos[0] ?? '')
    if (!c || c.rel === 'self') return (console.error(`no contact "${pos[0] ?? ''}"`), 1)
    const sn = safetyNumber(node.identity.card.sign, c.id)
    console.log(`\nsafety number with ${c.name}: ${sn}\nCompare it with what ${c.name}'s quietsync shows (\`quietsync verify ${node.identity.name}\` on their side), on a call or in person.\n`)
    if (!(await confirm('Does it match?', sn.slice(-5)))) return (console.log('not verified'), 1)
    node.markVerified(c.id)
    console.log(`${c.name} is verified`)
    return 0
  }

  if (cmd === 'roles') {
    for (const [r, help] of Object.entries(ROLE_HELP)) console.log(`  ${r.padEnd(10)} ${help}`)
    console.log('\nset with: quietsync role <peer|default|external|team|self|team:NAME> <role>')
    return 0
  }

  if (cmd === 'role') {
    const [scope, role] = pos
    if (!scope || !role || !(role in ROLES)) return (console.error(`usage: quietsync role <scope> <${Object.keys(ROLES).join('|')}>`), 1)
    return applyPolicy(store, scope, { role: role as Role })
  }

  if (cmd === 'desktop') {
    // Claude Desktop chat: messages only, sends approved on a local page.
    const cfgPath =
      process.env.QUIETSYNC_DESKTOP_CONFIG ||
      (process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : process.platform === 'win32'
          ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
          : join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'))
    const entry = { command: process.execPath, args: [resolve(process.argv[1] ?? 'quietsync.mjs'), 'mcp', '--surface', 'desktop'] }
    if (pos[0] === 'install' && o.print) return (console.log(JSON.stringify({ mcpServers: { quietsync: entry } }, null, 2)), 0)
    if (pos[0] !== 'install' && pos[0] !== 'remove') return (console.error('usage: quietsync desktop install [--print] | remove'), 1)
    if (!process.stdin.isTTY || !process.stdout.isTTY || underAgent()) return (console.error(HUMAN_ONLY), 1)
    let cfg: { mcpServers?: Record<string, unknown> } = {}
    if (existsSync(cfgPath)) {
      cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
      writeFileSync(`${cfgPath}.bak`, readFileSync(cfgPath))
    }
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}) }
    if (pos[0] === 'install') cfg.mcpServers.quietsync = entry
    else delete cfg.mcpServers.quietsync
    mkdirSync(dirname(cfgPath), { recursive: true })
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
    console.log(`${pos[0] === 'install' ? 'added quietsync to' : 'removed quietsync from'} ${cfgPath}${existsSync(`${cfgPath}.bak`) ? ' (the old one is .bak)' : ''}. Restart Claude Desktop.${pos[0] === 'install' ? ' Sends open an approval page in your browser; live links stay in Claude Code.' : ''}`)
    return 0
  }

  if (cmd === 'keys') {
    const ks = systemKeyStore()
    if (!pos[0]) {
      console.log(store.keysInKeychain() ? `private keys are in the ${ks?.kind ?? 'OS keychain'}` : `private keys are in ${store.path('identity.json')} (owner-only)${ks ? `; \`quietsync keys keychain\` moves them to the ${ks.kind}` : ''}`)
      return 0
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY || underAgent()) return (console.error(HUMAN_ONLY), 1)
    if (pos[0] === 'keychain' || pos[0] === 'file') {
      store.saveIdentity(store.requireIdentity(), { keychain: pos[0] === 'keychain' })
      console.log(pos[0] === 'keychain' ? `moved to the ${ks?.kind}; identity.json keeps only the public half` : `moved back to ${store.path('identity.json')}`)
      return 0
    }
    if (pos[0] === 'rotate') return rotateKeys(store)
    console.error('usage: quietsync keys [keychain|file|rotate]')
    return 1
  }

  if (cmd === 'journal') {
    // For the company's admin, not for each person: make the key pair, read what's kept.
    if (pos[0] === 'keygen') {
      const out = o.out ? String(o.out) : ''
      if (!out) return (console.error('usage: quietsync journal keygen --out <private key file>'), 1)
      if (existsSync(out)) return (console.error(`${out} already exists`), 1)
      const k = journalKeygen()
      writeFileSync(out, `${k.privateKey}\n`, { mode: 0o600, flag: 'wx' })
      console.log(`private key saved to ${out} (owner-only). Keep it with whoever handles retention and legal hold; nobody else needs it.\n\nPut this in the managed policy on every machine:\n${JSON.stringify({ journal: { key: k.publicKey } }, null, 2)}`)
      return 0
    }
    if (pos[0] === 'read' && pos[1] && o.key) {
      const entries = readJournal(pos[1], readFileSync(String(o.key), 'utf8').trim())
      for (const e of entries) console.log(o.json ? JSON.stringify(e) : `${e.ts} ${(e.by as { name: string }).name} ${e.dir ?? ''} ${e.event} ${e.peer ?? ''} ${typeof e.text === 'string' ? JSON.stringify(e.text).slice(0, 200) : ''}`)
      return 0
    }
    console.error('usage: quietsync journal keygen --out <file> | read <file or folder> --key <private key file> [--json]')
    return 1
  }

  if (cmd === 'mode') {
    const [scope, mode] = pos
    if (!scope || !isMode(mode)) {
      console.error(`usage: quietsync mode <peer|default|external|team|self|team:NAME> <${MODES.join('|')}>\n${MODES.map(m => `  ${m.padEnd(8)} ${MODE_HELP[m]}`).join('\n')}`)
      return 1
    }
    return applyPolicy(store, scope, { mode })
  }

  if (cmd === 'rules') {
    const [verb, ...rest] = pos
    const rule = rest.join(' ').trim()
    if (!verb || verb === 'list') {
      const mine = store.policyFile().rules ?? {}
      const admin = loadManagedPolicy()?.rules ?? {}
      for (const k of ['deny', 'ask', 'allow'] as const) {
        for (const r of admin[k] ?? []) console.log(`  ${k.padEnd(5)} ${r}  (managed)`)
        for (const r of mine[k] ?? []) console.log(`  ${k.padEnd(5)} ${r}`)
      }
      if (![...Object.values(mine), ...Object.values(admin)].some(l => l?.length)) console.log('no rules: each person\'s mode decides. Add one with `quietsync rules allow|ask|deny "<kind>(<who>)"`.')
      return 0
    }
    if ((verb === 'allow' || verb === 'ask' || verb === 'deny') && rule) {
      const bad = checkRule(rule)
      if (bad) return (console.error(bad), 1)
      return applyFileChange(store, `rule ${verb} ${rule}`, f => {
        const r = (f.rules ??= {})
        for (const k of ['allow', 'ask', 'deny'] as const) r[k] = (r[k] ?? []).filter(x => x !== rule)
        r[verb] = [...(r[verb] ?? []), rule]
      }, verb === 'allow' ? [`${rule} flows without a person, up to what your mode caps allow`] : [])
    }
    if (verb === 'remove' && rule) {
      return applyFileChange(store, `remove rule ${rule}`, f => {
        for (const k of ['allow', 'ask', 'deny'] as const) if (f.rules?.[k]) f.rules[k] = f.rules[k]!.filter(x => x !== rule)
      })
    }
    console.error('usage: quietsync rules [list] | allow|ask|deny "<kind>(<who>)" | remove "<rule>"')
    return 1
  }

  if (cmd === 'trust') {
    const ref = pos[0]
    if (!ref) return (console.error('usage: quietsync trust <peer> [--auto-accept on|off] [--send ask|auto]'), 1)
    const patch: PolicyPatch = {}
    if (o['auto-accept']) patch.links = o['auto-accept'] === 'on' ? 'auto' : 'ask'
    if (o.send === 'ask' || o.send === 'auto') patch.send = o.send
    return applyPolicy(store, ref, patch)
  }

  if (cmd === 'policy') {
    if (pos[0] === 'show' || !pos[0]) {
      const node = store.hasIdentity() ? offlineNode(store) : null
      console.log(`file: ${store.path('policy.json')}`)
      const managed = loadManagedPolicy()
      console.log(`managed: ${managed ? managedPolicyPath() : 'none'}`)
      for (const rel of ['external', 'team', 'self'] as const) console.log(`  ${rel.padEnd(9)} ${describePolicy(resolvePolicy(store.policyFile(), managed, { id: '', rel, teams: [] }))}`)
      if (node) {
        const all = store.contacts()
        for (const c of Object.values(all)) {
          if (pos[1] && node.resolvePeer(pos[1])?.id !== c.id) continue
          console.log(`  ${contactLabel(c, all, store.teams()).padEnd(22)} ${describePolicy(node.policyFor(c.id))}`)
        }
      }
      const pol = new Policies(store)
      pol.dlp()
      if (pol.badRules.length) console.log(`invalid dlp rules ignored: ${pol.badRules.join(', ')}`)
      return 0
    }
    if (pos[0] === 'set') {
      const scope = pos[1]
      const pairs = pos.slice(2)
      if (!scope || !pairs.length) return (console.error('usage: quietsync policy set <scope> key=value …'), 1)
      const patch: Record<string, unknown> = {}
      for (const kv of pairs) {
        const [k, v] = kv.split('=')
        if (!k || v === undefined) return (console.error(`bad "${kv}", use key=value`), 1)
        if (k.startsWith('caps.')) ((patch.caps ??= {}) as Record<string, unknown>)[k.slice(5)] = parseValue(v)
        else patch[k] = parseValue(v)
      }
      return applyPolicy(store, scope, patch as PolicyPatch)
    }
    return (console.error('usage: quietsync policy show [peer] | policy set <scope> key=value …'), 1)
  }

  if (cmd === 'block' || cmd === 'unblock') {
    const c = offlineNode(store).resolvePeer(pos[0] ?? '') ?? Object.values(store.contacts()).find(x => x.name === pos[0])
    if (!c || c.rel === 'self') return (console.error(`no contact "${pos[0]}"`), 1)
    store.updateContacts(all => {
      all[c.id]!.blocked = cmd === 'block'
    })
    console.log(`${cmd}ed ${c.name}`)
    return 0
  }

  if (cmd === 'team') {
    const sub = pos[0]
    if (sub === 'create') {
      if (!pos[1]) return (console.error('usage: quietsync team create <name>'), 1)
      return withNode(store, async node => {
        const t = await node.teamCreate(pos[1]!, o.handle)
        if (o.profile) {
          if (!isProfile(o.profile)) throw new Error('--profile must be company, friends or startup')
          await node.teamSetProfile(t.card.teamId, { profile: o.profile })
        }
        console.log(`created team ${t.card.name} (${t.card.teamId}), you're ${t.handle}${t.card.org ? `, tied to your org plan` : ''}${o.profile ? `, profile ${o.profile}` : ''}\ninvite people with: quietsync team invite ${t.card.name}`)
        console.log('keep one quietsync session or `quietsync team sync` running now and then: your quietsync admits people who join')
        return 0
      })
    }
    if (sub === 'profile') {
      const ref = pos[1] ?? ''
      if (!pos[2]) {
        const t = offlineNode(store).teamByRef(ref)
        const c = t.policy?.choice
        console.log(c ? `${t.card.name}: profile ${c.profile ?? 'default'}${c.features ? ` with ${JSON.stringify(c.features)}` : ''}` : `${t.card.name} has no profile; members use their own`)
        return 0
      }
      const profile = pos[2]
      if (!isProfile(profile)) return (console.error('usage: quietsync team profile <team> <company|friends|startup|default> [key=value …]'), 1)
      const features = featureOverrides(pos.slice(3))
      return withNode(store, async node => {
        await node.teamSetProfile(ref, { profile, ...(Object.keys(features).length ? { features } : {}) })
        console.log(`${ref} now runs under ${pos[2]}. Members pick it up on their next sync (within 10 minutes, or when a session starts).`)
        console.log('A team profile can only take things away from members; it never loosens their own settings.')
        return 0
      })
    }
    if (sub === 'invite') {
      const max = o.max ? Number(o.max) : undefined
      const code = offlineNode(store).teamInvite(pos[1] ?? '', duration(o.ttl, 7 * 8.64e7), max)
      console.log(`share with your team (works until it expires in ${o.ttl ?? '7d'}${max ? `, for ${max} people` : ''}):\n\n${code}\n\nthey run: quietsync team join <code>`)
      return 0
    }
    if (sub === 'join') {
      if (!pos[1]) return (console.error('usage: quietsync team join <code>'), 1)
      const inv = decodeInvite(pos[1])
      if (!store.config().relay) store.setConfig({ relay: inv.r })
      return withNode(store, async node => {
        const r = await node.teamJoin(pos[1]!, o.handle)
        console.log(r.admitted ? `joined ${r.team.card.name} as ${r.team.handle}, ${r.members} members` : `asked to join ${r.team.card.name} as ${r.team.handle}; the admin's quietsync admits you next time it syncs`)
        return 0
      })
    }
    if (sub === 'sync') {
      return withNode(store, async node => {
        await node.teamSync()
        console.log(contactRows(store).join('\n'))
        return 0
      })
    }
    if (sub === 'members') {
      return withNode(store, async node => {
        await node.teamSync()
        for (const t of Object.values(store.teams())) {
          if (pos[1] && t.card.name !== pos[1]) continue
          const s = await node.teamState(t.card.teamId)
          console.log(`${t.card.name} (${t.card.teamId})${t.adminKey ? ' [admin]' : ''}`)
          for (const m of s.members) console.log(`  ${m.handle.padEnd(20)} ${fingerprint(m.card.sign)}`)
          for (const m of s.pending) console.log(`  ${m.handle.padEnd(20)} ${fingerprint(m.card.sign)}  (waiting to be admitted)`)
        }
        return 0
      })
    }
    if (sub === 'remove') {
      return withNode(store, async node => {
        await node.teamRemove(pos[1] ?? '', pos[2] ?? '')
        console.log(`removed ${pos[2]} from ${pos[1]}`)
        return 0
      })
    }
    return (console.error('usage: quietsync team <create|invite|join|members|sync|remove>'), 1)
  }

  if (cmd === 'device') {
    if (pos[0] === 'add') {
      return withNode(store, async node => {
        const wait = duration(o.wait, 10 * 6e4)
        const { code, inviteId } = node.createDeviceInvite(wait)
        console.log(`on your other machine run:\n\n  quietsync device join ${code}\n\nthis copies your identity there. Only do it on machines you own.`)
        const r = await node.waitDeviceJoin(inviteId, wait)
        console.log(r ? `added device ${r.deviceName}` : 'timed out, nothing was shared')
        return r ? 0 : 1
      })
    }
    if (pos[0] === 'join') {
      if (!pos[1]) return (console.error('usage: quietsync device join <code>'), 1)
      const id = await AgentNode.joinDevice(store, pos[1], o.name ?? o.device ?? store.config().deviceName)
      if (!o['no-keychain'] && keychainByDefault()) store.saveIdentity(id, { keychain: true })
      console.log(`this machine is now ${id.name} (${fingerprint(id.card.sign)})`)
      return 0
    }
    if (pos[0] === 'revoke') return rotateKeys(store)
    return (console.error('usage: quietsync device <add|join|revoke>'), 1)
  }

  if (cmd === 'files') {
    const list = offlineNode(store).receivedFiles()
    console.log(`inbox: ${store.inboxDir()}`)
    if (!list.length) return (console.log('no files received yet'), 0)
    for (const f of list.slice(0, Number(o.n ?? 30))) {
      console.log(`  ${new Date(f.at).toISOString().slice(0, 16).replace('T', ' ')}  ${f.by.padEnd(16)} ${f.kind.padEnd(10)} ${String(f.size).padStart(9)} B  ${f.path}`)
    }
    console.log("\nThese came from other people and are untrusted. Don't run or unpack them unless you know what they are.")
    return 0
  }

  if (cmd === 'sessions') {
    const dir = store.path('sessions')
    const rows: string[] = []
    for (const f of readdirSync(dir)) {
      try {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        try {
          process.kill(s.pid, 0)
        } catch {
          continue
        }
        const v = s.view
        rows.push(`  ${v.session.label.padEnd(20)} ${v.session.agent.padEnd(12)} links ${v.links}  requests ${v.incoming}  relay ${v.relay.connected ? 'up' : 'down'}  (${v.session.id})`)
      } catch {}
    }
    console.log(rows.length ? rows.join('\n') : 'no agent sessions running quietsync')
    return 0
  }

  if (cmd === 'log') {
    const dir = store.path('audit')
    const files = readdirSync(dir).sort().slice(-3)
    const lines = files.flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n')).filter(Boolean)
    for (const l of lines.slice(-Number(o.n ?? 30))) {
      const e = JSON.parse(l)
      const peer = e.peer ? (store.contacts()[e.peer]?.name ?? e.peer.slice(0, 8)) : (e.by ?? e.after ?? '')
      const detail = (() => {
        if (e.event === 'tool') return `${e.privilege === 'peer' ? 'PEER TURN ' : ''}${e.tool.replace(/^mcp__.*__/, '')} -> ${e.decision}${e.target ? `  ${JSON.stringify(e.target).slice(0, 70)}` : ''}`
        if (e.event === 'turn.peer') return `peer turn starts, lower privilege${e.reason ? ` (${e.reason})` : ''}`
        if (e.event === 'turn.human') return 'human takes over'
        if (e.text) return JSON.stringify(e.text).slice(0, 80)
        if (Array.isArray(e.members)) return `${e.team}: ${e.members.join(', ')}`
        if (e.name) return `${JSON.stringify(e.name)}${e.size !== undefined ? `, ${Math.max(1, Math.round(e.size / 1024))} KB` : ''}`
        return e.reason ?? e.topic ?? (e.chars !== undefined ? `${e.chars} chars` : '')
      })()
      console.log(`${e.ts.slice(11, 19)} ${String(e.dir ?? '').padEnd(3)} ${String(e.event).padEnd(15)} ${String(peer).slice(0, 14).padEnd(14)} ${detail}`)
    }
    return 0
  }

  if (cmd === 'doctor') {
    let failed = 0
    const ok = (b: boolean, s: string) => {
      if (!b) failed++
      console.log(`${b ? 'ok  ' : 'FAIL'} ${s}`)
    }
    const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`
    const runtimeOk = !!process.versions.bun || Number(process.versions.node.split('.')[0]) >= 22
    ok(runtimeOk, `runtime ${runtime}${runtimeOk ? '' : ', quietsync needs Node 22+ or Bun'}`)
    const id = store.identity()
    ok(!!id, id ? `identity ${id.name} ${fingerprint(id.card.sign)}` : 'no identity, run quietsync setup')
    const relay = store.config().relay
    ok(!!relay, `relay ${relay ?? 'not set'}`)
    if (id && relay) {
      try {
        await withNode(store, async () => 0)
        ok(true, 'relay reachable and accepted our key')
      } catch (e) {
        ok(false, `relay: ${(e as Error).message}`)
      }
    }
    const claude = sh('claude', ['plugin', 'list', '--json'])
    if (claude.ok) {
      ok(claude.out.includes('"quietsync@quietsync"'), 'Claude Code plugin quietsync installed')
      console.log(`${claude.out.includes('"quietsync-ui@quietsync"') ? 'ok  ' : 'info'} Claude Code plugin quietsync-ui ${claude.out.includes('"quietsync-ui@quietsync"') ? 'installed' : 'not installed (no band, no wake-up; hooks still work)'}`)
    } else console.log('info Claude Code CLI not found on PATH')
    const sample = store.socketPath('0123456789ab-session')
    ok(process.platform === 'win32' || sample.length <= 100, sample.length <= 100 ? 'control socket path fits' : `control socket path is ${sample.length} bytes (max about 100): set QUIETSYNC_RUN_DIR to a short folder`)
    const managed = loadManagedPolicy()
    console.log(`info managed policy ${managed ? `at ${managedPolicyPath()}` : 'none'}`)
    const p = new Policies(store)
    const r = p.features()
    console.log(`info profile ${r.profile}${p.org ? `, signed into ${p.org.name} (${p.org.plan}): org-only` : ''}`)
    p.dlp()
    ok(!p.badRules.length, p.badRules.length ? `invalid dlp rules in policy.json: ${p.badRules.join(', ')}` : 'policy.json rules compile')
    return failed ? 1 : 0
  }

  console.error(`unknown command "${cmd}"\n`)
  console.log(HELP)
  return 1
}

main(process.argv.slice(2)).then(
  code => {
    if (code >= 0) process.exit(code)
  },
  e => {
    console.error(`quietsync: ${(e as Error).message}`)
    process.exit(1)
  },
)
