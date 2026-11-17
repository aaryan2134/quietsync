# Policy: who can do what

Everything here is your choice, per person, per team, or for everyone. The defaults are the safe end: both humans approve each link, you approve every send, secrets get redacted.

For whole groups there are ready-made profiles (`company`, `friends`, `startup`) that switch features on and off together, and team admins can publish one for their team. On a Claude Team or Enterprise plan you can only link with colleagues. See [profiles.md](profiles.md); this page covers the finer controls underneath.

## Roles

A role sets four capabilities for links with someone:

| role | you start links | you accept theirs | your agent sends | your agent reads theirs | typical use |
|---|---|---|---|---|---|
| `peer` (default) | yes | yes | yes | yes | normal two-way chat |
| `asker` | yes | no | yes | yes | you ask them things, they can't open links to you |
| `responder` | no | yes | yes | yes | you answer their questions, you never start |
| `listener` | no | yes | no | yes | they post updates to you, your agent never replies |
| `notifier` | yes | no | yes | no | you push updates out, their replies are dropped |
| `off` | no | no | no | no | nothing either way |

Each side enforces its own role and tells the other side, so a `listener`'s peer is told "they won't reply" instead of waiting for an answer. A request to someone who doesn't accept from you comes back declined with "not accepting links from you".

You can also set the four capabilities directly (`caps.initiate`, `caps.accept`, `caps.send`, `caps.receive`) when no role fits.

## Approvals

| key | values | what it means |
|---|---|---|
| `links` | `ask` (default), `auto` | incoming link requests: you click Accept, or they're accepted for you |
| `send` | `ask` (default), `auto` | every outgoing message: you approve the exact text, or it goes out on its own |
| `autoSendLimit` | number, default 10 | auto-send stops and asks again after this many sends in a row without you typing anything |

Auto-send never applies to a message the scanner flagged (a redaction, a warning, hidden characters). Those always come to you.

## Isolation

What your agent can do while a peer is involved.

| level | while a peer message drives the turn | while a link is open otherwise |
|---|---|---|
| `relaxed` | only commands and tools that can send data off the machine ask | nothing extra |
| `standard` (teams, own devices) | everything except reading files asks | network commands and web fetches ask |
| `strict` (external peers) | everything except reading files asks, and reads outside the project ask | same as a peer-driven turn, until the link closes |

On top of every level: `.env` files, keys, cloud credentials and anything in your `protect` list are refused during peer-driven turns and ask while a link is open, and QuietSync's own files are always off limits to the agent.

## Secrets

| key | values | what it means |
|---|---|---|
| `secrets` | `redact` (default), `block` | redact replaces each secret with `[redacted <kind>]` and shows you; block refuses the send and tells your agent to rewrite it |
| `maxMessageChars` | 200 to 16000, default 8000 | longer sends are refused, so the approval dialog always shows the whole thing |
| `maxFileMB` | 0 to 50, default 10 | largest file you'll send to, or accept from, that person; 0 turns files off for them |

What gets caught: private keys, cloud and SaaS tokens (AWS, GCP, Azure, GitHub, GitLab, Slack, Stripe, OpenAI, Anthropic and about 30 more), JWTs, auth headers, URLs with passwords, `key = value` style secrets, card numbers, base64-wrapped versions of all of those, the actual values of secret-looking environment variables on your machine, and QuietSync's own keys. Random-looking tokens, private IP addresses and SSN-like numbers are flagged for you to look at but not removed.

Only your human (band button, per link) can let secrets through, and an admin can turn that off entirely.

## Where it's set

Rules live in `~/.quietsync/policy.json`. Layers apply most general first, later ones win:

1. built-in defaults (external peers get `strict` isolation), then your profile's defaults
2. `default`
3. `external`, `team` or `self`, by relationship
4. `teams.<team name or id>` (a peer in several teams gets the strictest of them)
5. `contacts.<key>`
6. the session's mode, which can only narrow (`/links mode listener`, or `QUIETSYNC_ROLE=listener` in the environment)
7. limits from your profile, your teams' profiles and your org plan (see [profiles.md](profiles.md)), which can only narrow
8. your organization's managed policy, which can only narrow

```json
{
  "default": { "secrets": "redact" },
  "external": { "role": "responder" },
  "team": { "links": "auto" },
  "teams": { "payments": { "send": "auto", "autoSendLimit": 5 } },
  "contacts": { "<their key>": { "role": "listener" } },
  "dlp": {
    "block": ["PROJ-[A-Z]+-\\d+"],
    "warn": ["\\binternal\\.example\\.com\\b"],
    "terms": ["internal only", "do not share"]
  },
  "protect": ["**/prod-config/**"],
  "maxLinks": 8,
  "allowInsecureRelays": false
}
```

`dlp.block` patterns are redacted or blocked like secrets, `dlp.warn` patterns and `terms` are shown to you before sending. `protect` adds paths to the sensitive list (globs, `~` works).

Change it from your own terminal, not through the agent:

```sh
quietsync roles                                  # what each role means
quietsync role priya listener                    # one person
quietsync role team:payments responder           # a whole team
quietsync role external asker                    # everyone outside your teams
quietsync policy set default send=auto           # any key
quietsync policy set bob caps.receive=false
quietsync policy show                            # what applies to whom
```

Anything that loosens (more capabilities, auto-approval, weaker isolation) asks you to type a confirmation. The agent's shell has no terminal, so it can't get past that, and the agent is refused if it tries to edit `policy.json` directly.

A running session reads `policy.json` when it starts. Tightening applies right away; loosening only takes effect in new sessions, so an agent that somehow wrote to the file can't loosen the session it's in. The band says so when the file changed.

## For admins: managed policy

Put a JSON file at:

- macOS: `/Library/Application Support/quietsync/managed.json`
- Linux: `/etc/quietsync/managed.json`
- Windows: `%ProgramData%\quietsync\managed.json`

or point `QUIETSYNC_MANAGED_POLICY` at one. Deploy it the way you deploy Claude Code's managed settings (MDM, config management). Users can't override it.

```json
{
  "ceiling": { "send": "ask", "isolation": "standard", "caps": { "initiate": true } },
  "allowExternal": false,
  "allowSecretsOverride": false,
  "allowRelays": ["wss://quietsync.corp.example.com"],
  "dlp": { "block": ["ACME-[0-9]{6}"], "terms": ["confidential"] },
  "protect": ["**/customer-data/**"],
  "maxLinks": 4
}
```

| key | effect |
|---|---|
| `ceiling` | a policy patch that can only narrow: `send: "ask"` forbids auto-send, `isolation` sets a minimum, `caps.x: false` removes a capability, a `role` caps everyone at that role |
| `allowExternal: false` | no pairing with people outside your teams, and existing external contacts drop to `off` |
| `allowSecretsOverride: false` | removes the "allow secrets on this link" option |
| `allowRelays` | the only relays QuietSync will connect to |
| `dlp`, `protect` | added to every user's rules |
| `maxLinks` | upper bound on links per session |

To lock the plugin itself in place, use Claude Code's own managed settings: `enabledPlugins` to force it on, `strictKnownMarketplaces` to pin where it can come from.
