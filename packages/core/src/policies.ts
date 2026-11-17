import { statSync } from 'node:fs'
import type { Canary, DlpOptions } from './dlp.ts'
import { pathGuard, type PathGuard } from './guard.ts'
import { detectOrg, orgTag, resolveFeatures, type FeatureSource, type OrgInfo, type ResolvedFeatures } from './profiles.ts'
import {
  checkRelayUrl,
  clamp,
  loadEnvPolicy,
  loadManagedPolicy,
  managedPolicyPath,
  resolvePolicy,
  withFlow,
  type DlpConfig,
  type ManagedPolicy,
  type Policy,
  type PolicyFile,
  type PolicyPatch,
  type PolicySubject,
} from './rules.ts'
import type { Contact, Store, StoredTeam } from './store.ts'
import { cleanRules, mergeRules, narrowingRules, type Rules } from './levels.ts'
import { checkJournal, type JournalConfig } from './journal.ts'
import type { TeamCard, TeamPolicy } from './team.ts'

const DEFAULT_MAX_LINKS = 8

function asPatch(p: Policy): PolicyPatch {
  return { caps: p.caps, links: p.links, send: p.send, isolation: p.isolation, secrets: p.secrets, autoSendLimit: p.autoSendLimit, maxMessageChars: p.maxMessageChars, maxFileMB: p.maxFileMB, mode: p.mode }
}

function regexes(list: string[] | undefined, bad: string[]): RegExp[] {
  const out: RegExp[] = []
  for (const s of list ?? []) {
    try {
      out.push(new RegExp(s, 'gi'))
    } catch {
      bad.push(s)
    }
  }
  return out
}

// The policy a running session enforces. The file is read once at start;
// later edits to it can only tighten things until the next session, so an
// agent that manages to write policy.json can't loosen the session it's in.
export class Policies {
  readonly managed: ManagedPolicy | null
  readonly envPolicy: ManagedPolicy | null
  readonly org: OrgInfo | null
  readonly badRules: string[] = []
  private baseline: PolicyFile
  private current: PolicyFile
  private mtime = 0
  private session: PolicyPatch | undefined
  private dlpCache: DlpOptions | null = null
  private canaries: Canary[]

  constructor(
    private store: Store,
    opts: { managed?: ManagedPolicy | null; org?: OrgInfo | null; session?: PolicyPatch; canaries?: Canary[] } = {},
  ) {
    this.managed = opts.managed === undefined ? loadManagedPolicy() : opts.managed
    this.envPolicy = opts.managed === undefined ? loadEnvPolicy() : null
    this.org = opts.org === undefined ? detectOrg() : opts.org
    this.baseline = store.policyFile()
    this.current = this.baseline
    this.mtime = this.fileMtime()
    this.session = opts.session
    this.canaries = opts.canaries ?? []
    store.auditLevel = this.features().features.audit
  }

  private fileMtime(): number {
    try {
      return statSync(this.store.path('policy.json')).mtimeMs
    } catch {
      return 0
    }
  }

  private file(): PolicyFile {
    const m = this.fileMtime()
    if (m !== this.mtime) {
      this.mtime = m
      this.current = this.store.policyFile()
      this.dlpCache = null
    }
    return this.current
  }

  // True when policy.json changed since this session started in a way that
  // can't take effect until a new session.
  get changedOnDisk(): boolean {
    return this.file() !== this.baseline
  }

  get orgTag(): string | null {
    return this.org ? orgTag(this.org.id) : null
  }

  // Which teams count as "the org". An admin's list wins; on an org plan it's
  // teams carrying the plan's tag; otherwise a team whose own profile is
  // org-only is the boundary for its members.
  isOrgTeam(team: { card: TeamCard; policy?: TeamPolicy }): boolean {
    const pinned = this.managed?.org?.teams
    if (pinned?.length) return pinned.includes(team.card.teamId)
    if (this.org) return team.card.org === this.orgTag
    return !!team.policy && resolveFeatures([{ kind: 'team', label: '', choice: team.policy.choice }]).features.orgOnly
  }

  // Joining is only fenced in when the org is known: an org plan or an admin's list.
  joinAllowed(card: TeamCard): boolean {
    if (!this.managed?.org?.teams?.length && !this.org) return true
    return this.isOrgTeam({ card })
  }

  // ---- profiles and features ----------------------------------------------

  sources(): FeatureSource[] {
    const out: FeatureSource[] = []
    const m = this.managed
    if (m && (m.profile || m.features || m.modes || m.allowExternal !== undefined || m.allowSecretsOverride !== undefined)) {
      const features = { ...m.features }
      if (m.allowExternal !== undefined) features.external = m.allowExternal
      if (m.allowSecretsOverride !== undefined) features.secretsOverride = m.allowSecretsOverride
      out.push({ kind: 'managed', label: 'managed policy', choice: { profile: m.profile, features, protect: m.protect, modes: m.modes } })
    }
    const e = this.envPolicy
    if (e) {
      // Counts like a team: it can switch things off and add limits, never on.
      const features = { ...e.features }
      if (e.allowExternal === false) features.external = false
      if (e.allowSecretsOverride === false) features.secretsOverride = false
      out.push({ kind: 'team', label: 'QUIETSYNC_MANAGED_POLICY', choice: { profile: e.profile, features, ceiling: e.ceiling, protect: e.protect, modes: e.modes } })
    }
    if (this.org) out.push({ kind: 'org', label: `org plan (${this.org.name})`, choice: { features: { orgOnly: true } } })
    for (const t of Object.values(this.store.teams() as Record<string, StoredTeam>)) {
      if (t.policy?.choice) out.push({ kind: 'team', label: `team ${t.card.name}`, choice: t.policy.choice })
    }
    const mine = (f: PolicyFile, label: string) => (f.profile || f.features ? out.push({ kind: 'you', label, choice: { profile: f.profile, features: f.features } }) : 0)
    if (!mine(this.baseline, 'you') && this.org) out.push({ kind: 'you', label: 'company (default on org plans)', choice: { profile: 'company' } })
    const now = this.file()
    if (now !== this.baseline) mine(now, 'you (edited, applies only if stricter)')
    return out
  }

  // Asked several times per tool call; recomputed only when a team or policy file changes.
  private featCache: { key: string; value: ResolvedFeatures } | null = null

  features(): ResolvedFeatures {
    let teamsMtime = 0
    try {
      teamsMtime = statSync(this.store.path('teams.json')).mtimeMs
    } catch {}
    this.file()
    const key = `${teamsMtime}|${this.mtime}|${this.baseline === this.current}`
    if (this.featCache?.key !== key) this.featCache = { key, value: resolveFeatures(this.sources()) }
    return this.featCache.value
  }

  // Why this person is kept out entirely, or null.
  admission(who: PolicySubject, f = this.features().features): string | null {
    if (who.rel === 'self') return null
    const name = who.name ?? 'this person'
    if (f.orgOnly && !who.teams.some(t => t.org)) {
      return this.org
        ? `${name} isn't in one of your org's quietsync teams. On the ${this.org.name} plan you can only link with colleagues.`
        : `${name} isn't in one of your org's quietsync teams, and your profile only allows colleagues.`
    }
    if (!f.external && who.rel === 'external') return `links with people outside your teams are turned off (${this.features().from.external})`
    if (f.requireVerified && who.rel === 'external' && !who.verified) {
      return `confirm ${name}'s safety number first: run \`quietsync verify ${name}\` in your terminal and compare it with them`
    }
    return null
  }

  subject(c: Contact, teams: Record<string, StoredTeam>): PolicySubject {
    return {
      id: c.id,
      rel: c.rel,
      name: c.name,
      verified: c.verified === true,
      teams: c.teams.map(t => ({ id: t, name: teams[t]?.card.name ?? t, org: teams[t] ? this.isOrgTeam(teams[t]!) : false })),
    }
  }

  resolve(who: PolicySubject): Policy {
    const rf = this.features()
    let p = resolvePolicy(this.baseline, this.managed, who, this.session, rf.defaults)
    const now = this.file()
    if (now !== this.baseline) p = clamp(p, asPatch(resolvePolicy(now, this.managed, who, this.session, rf.defaults)))
    for (const c of rf.ceilings) p = clamp(p, c)
    if (!rf.features.autoSend) p = clamp(p, { send: 'ask' })
    if (!rf.features.autoAccept) p = clamp(p, { links: 'ask' })
    const cap = rf.modes[who.rel]
    if (cap) p = clamp(p, { mode: cap })
    p = withFlow(p, this.rules(), who)
    const blocked = this.admission(who, rf.features)
    return blocked ? { ...clamp(p, { role: 'off' }), blockedBy: blocked } : p
  }

  // Allow rules count from the human's own file and the admin; teams, an env file
  // and an edited file can only add ask and deny.
  rules(): Rules {
    const teams = Object.values(this.store.teams() as Record<string, StoredTeam>).map(t => narrowingRules(cleanRules(t.policy?.choice?.rules)))
    const now = this.file()
    return mergeRules(this.managed?.rules, this.baseline.rules, now !== this.baseline ? narrowingRules(now.rules) : undefined, narrowingRules(this.envPolicy?.rules), ...teams)
  }

  forContact(c: Contact): Policy {
    return this.resolve(this.subject(c, this.store.teams()))
  }

  // Human-only: the band, or the CLI after a TTY confirmation. Applies to this
  // session right away and becomes the new baseline.
  humanUpdate(fn: (p: PolicyFile) => PolicyFile | void): PolicyFile {
    const next = this.store.updatePolicyFile(fn)
    this.baseline = next
    this.current = next
    this.mtime = this.fileMtime()
    this.dlpCache = null
    this.featCache = null
    this.store.auditLevel = this.features().features.audit
    return next
  }

  setSession(patch: PolicyPatch | undefined): void {
    this.session = patch
  }

  get sessionPatch(): PolicyPatch | undefined {
    return this.session
  }

  maxLinks(): number {
    const user = this.baseline.maxLinks ?? DEFAULT_MAX_LINKS
    return Math.max(1, Math.min(user, this.managed?.maxLinks ?? Infinity, 50))
  }

  // The admin's journal wins; an env policy can add one for testing or machines without MDM.
  journal(): JournalConfig | null {
    for (const j of [this.managed?.journal, this.envPolicy?.journal]) if (j && !checkJournal(j)) return j
    return null
  }

  // Auto-send for a link only counts if nothing above the user forbids it.
  autoSendAllowed(): boolean {
    const r = this.features()
    return r.features.autoSend && !r.ceilings.some(c => c.send === 'ask') && this.managed?.ceiling?.send !== 'ask'
  }

  // Peer messages in a row that may wake the agent before the human has to step in.
  wakeLimit(): number {
    return Math.max(1, Math.min(this.baseline.wakeLimit ?? 12, 100))
  }

  // Messages a peer may send on one link per minute; past it they're dropped, past twice that the link closes.
  inboundPerMinute(): number {
    return Math.max(1, Math.min(this.baseline.inboundPerMinute ?? 20, 10_000))
  }

  allowSecretsOverride(): boolean {
    return this.features().features.secretsOverride
  }

  relayCheck = (url: string): string | null =>
    checkRelayUrl(url, { allowInsecure: this.baseline.allowInsecureRelays === true && !this.managed?.allowRelays, allowRelays: this.managed?.allowRelays }) ??
    (this.envPolicy?.allowRelays ? checkRelayUrl(url, { allowInsecure: true, allowRelays: this.envPolicy.allowRelays }) : null)

  dlp(): DlpOptions {
    const f = this.file()
    if (this.dlpCache) return this.dlpCache
    const merge = (a?: DlpConfig, b?: DlpConfig): DlpConfig => ({
      block: [...(a?.block ?? []), ...(b?.block ?? [])],
      warn: [...(a?.warn ?? []), ...(b?.warn ?? [])],
      terms: [...(a?.terms ?? []), ...(b?.terms ?? [])],
    })
    // Rules from both the session's baseline and the file on disk apply: more rules only ever block more.
    const cfg = merge(merge(merge(this.baseline.dlp, f === this.baseline ? undefined : f.dlp), this.managed?.dlp), this.envPolicy?.dlp)
    this.badRules.length = 0
    this.dlpCache = {
      canaries: this.canaries,
      block: regexes(cfg.block, this.badRules),
      warn: regexes(cfg.warn, this.badRules),
      terms: cfg.terms,
    }
    return this.dlpCache
  }

  addCanaries(c: Canary[]): void {
    this.canaries = [...this.canaries, ...c]
    this.dlpCache = null
  }

  paths(): PathGuard {
    const f = this.file()
    return pathGuard({
      home: this.store.home,
      protect: [...(this.baseline.protect ?? []), ...(f.protect ?? []), ...(this.managed?.protect ?? []), ...this.features().protect],
      allow: this.managed?.protect ? [] : (this.baseline.allowPaths ?? []).filter(a => (f.allowPaths ?? []).includes(a)),
      extraConfig: [managedPolicyPath()],
      inbox: this.store.inboxDir(),
    })
  }
}
