# Profiles: company, friends, startup

QuietSync is used by three very different kinds of groups. A profile is a named set of switches that fits one of them. Pick one for yourself, or let your team's admin pick it for everyone in the team.

| | company | friends | startup |
|---|---|---|---|
| who | people at one company, work laptops | friends, classmates, side projects | a small team on personal laptops |
| security | high | low | high |
| privacy | medium | high | high |
| who you can link with | colleagues in your org's teams, your own devices | anyone you pair with | anyone you pair with, after confirming their safety number |
| highest mode ([levels](levels.md)) | teammates auto, outside ask | trusted | teammates auto, outside ask |
| auto-accept links | not allowed | allowed (you still turn it on) | not allowed |
| secrets in messages | blocked, nobody can override | redacted, you can allow per link | blocked, nobody can override |
| copy identity to another machine | no | yes | yes |
| audit log on your machine | full text, 90 days | no message text, 7 days | no message text, 30 days |
| peers see your machine and folder names | yes | no | no |
| read receipts | yes | no | no |
| files, images, zips | yes, up to 10 MB | yes, up to 25 MB | yes, up to 10 MB |
| messages that wait, records in Slack/Jira/email | yes | yes | yes |
| personal folders off limits during peer turns | no | yes | yes |
| extra limits | isolation at least standard, 5 auto-sends max, 8000 chars | none | isolation at least standard, 8000 chars |

Without a profile you get `default`: outside contacts start at `ask`, teammates at `review`, your own devices at `trusted`, secrets redacted, everything else allowed for you to turn on. `quietsync profile list` prints the full table.

Why "medium" privacy for companies: a company needs records of what went out, so the audit log keeps full message text. "High" privacy keeps only who, when and how long, never the text, and doesn't tell peers your machine or project names.

## Org plans: colleagues only

If Claude Code is signed into a **Team or Enterprise plan**, QuietSync only lets you link with:

- your own other devices
- people in your org's QuietSync teams

You can't make contact invites or pair with outside codes, and contacts from elsewhere are blocked. Your own profile can't change that; only an admin's managed policy can (`features.external: true`).

"Your org's teams" are teams created by someone on the same plan: the team card carries a tag derived from the plan's org id (a hash, so relays don't learn the id). Joining a team from another org, or one with no tag, is refused. For a stricter rule, an admin pins the exact team ids in the managed policy.

On an org plan your profile defaults to `company`. You can still pick another one for the parts that aren't locked, at your own terminal.

## Who sets the profile

Strongest first:

1. **managed policy** (your IT pushes it to the machine): decides outright, including switches nothing else can turn back on
2. **org plan**: locks you to colleagues
3. **each team you're in**: the team admin's published profile. It can only take things away: if any of your teams turns a switch off, it's off
4. **you**: `quietsync profile set <name>`
5. **default**

For records, whoever asks for the most detail wins: if your company team keeps full text for 90 days, your own "friends" choice doesn't shorten that.

`quietsync profile` shows every switch, its value, and which layer set it:

```
active profile: company   (signed into Acme, claude_team)

switch           value     set by                             meaning
external         false     company (default on org plans)     pair and link with people outside your teams
orgOnly          true      org plan (Acme)                    only link with people in your org's teams
autoSend         false     team payments                      auto-send may be turned on for a link or contact
...
```

## For team admins

```sh
quietsync team create payments --profile company       # new team, profile from day one
quietsync team profile payments startup                 # change it
quietsync team profile payments company receipts=false  # a profile plus overrides
quietsync team profile payments                         # see what's published
```

The profile is signed with the team key and stored in the team directory, so members' QuietSync can check it came from you and a relay can't change it. Members pick it up within 10 minutes or when a session starts. A team running an org-only profile (like `company`) is its own org: its members can talk to each other and to nobody outside it.

Switches you can set one by one: `external`, `orgOnly`, `autoSend`, `autoAccept`, `secretsOverride`, `requireVerified`, `devices`, `audit` (`full`, `metadata`, `off`), `auditDays`, `shareDevice`, `shareSession`, `receipts`, `files`, `messages`, `records`. The file size limit is `maxFileMB` in a profile's ceiling or `policy.json`.

## For IT: managed policy

Put this at `/Library/Application Support/quietsync/managed.json` (macOS), `/etc/quietsync/managed.json` (Linux) or `%ProgramData%\quietsync\managed.json` (Windows), with your usual device management:

```json
{
  "profile": "company",
  "features": { "devices": false, "audit": "full", "auditDays": 180 },
  "org": { "teams": ["<team id>", "<team id>"] },
  "allowRelays": ["wss://quietsync.corp.example.com"],
  "modes": { "team": "auto", "external": "ask" },
  "rules": { "ask": ["request(*)"] },
  "journal": { "key": "<public key from quietsync journal keygen>", "url": "https://archive.corp.example.com/quietsync" }
}
```

### A company copy of every message

Slack and email give a company a record it can keep, put on legal hold and search. QuietSync does too, if the managed policy sets a `journal`:

```sh
quietsync journal keygen --out quietsync-journal.key    # once, by whoever handles retention; prints the public key
quietsync journal read ~/.quietsync/journal --key quietsync-journal.key
```

- **What's kept:** every message, answer, file sent or received, and link opened or closed, by everyone on a machine with that policy. That's the full text, whatever their profile keeps in the audit log.
- **How it's sealed:** each entry is sealed to the public key, so people's own machines keep it (`~/.quietsync/journal`, or `dir`) but can't read it back, and the agent can't open it. With `url`, the same sealed lines are also posted to your collector over https.
- **Who's told:** the other side sees "their company keeps a copy" on links and messages from you, and you see "your company keeps a sealed copy" on your band. People should know.

Users can't change anything set here. Other managed settings (ceilings, extra leak rules, protected paths) are in [policy.md](policy.md#for-admins-managed-policy).

## For each person

```sh
quietsync profile                         # what applies to you and why
quietsync profile set friends             # your choice; loosening asks you to type a confirmation
quietsync profile set startup receipts=true
quietsync verify bob                      # compare safety numbers with bob, then mark him verified
```

The agent can't change any of this: the commands need a person at a real terminal, and QuietSync refuses the agent's attempts to run them or edit the files.

## Picking one

- Work laptop, colleagues only: **company**. On a Claude Team or Enterprise plan you get it by default.
- Group project, hackathon, friends helping each other: **friends**.
- Two to twenty people building something, each on their own machine with their own stuff on it: **startup**. Read each other's safety numbers once on a call, then link freely.
