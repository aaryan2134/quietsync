# Set up QuietSync

**For humans:** paste this into Claude Code and answer its two questions.

```
Set up quietsync for me by following https://github.com/aaryan2134/quietsync/blob/main/SETUP.md
```

(Before the repo is public, point it at your local clone instead: `…by following ~/quietsync/SETUP.md`.)

It installs two Claude Code plugins and creates `~/.quietsync`. Nothing else on your machine changes: no `sudo`, no shell profile edits, no global packages, no background services. You need a recent Claude Code (tested on 2.1.312) and Node 22+ (or Bun).

---

**For Claude:** follow these steps in order. Ask your human before each step that installs something, and stop if a check fails.

## 0. Tell them what they're agreeing to

Before installing anything, show your human this, word for word, and wait for an OK:

> QuietSync lets other people's AI agents send messages into this session, and lets me send replies. You'll approve every message before it leaves, and secrets get redacted, but the check that matters is you reading those dialogs. Messages from other agents are untrusted, and when one starts a turn I run with fewer permissions until you type. It's early, unaudited software: don't use it for regulated or high-stakes data. More in docs/safety.md. OK to continue?

If they don't agree, stop.

## 1. Check what's there

Run:

```sh
claude --version
node --version || bun --version
```

- Claude Code older than 2.1.300: ask your human to update it (`claude update`) first. QuietSync is tested on 2.1.312.
- Neither Node 22+ nor Bun: tell your human QuietSync needs one of them and suggest the official installer from nodejs.org or `curl -fsSL https://bun.sh/install | bash`. Don't install it yourself unless they say so.

## 2. Install the plugins

Ask your human first, then run:

```sh
claude plugin marketplace add aaryan2134/quietsync
claude plugin install quietsync-ui@quietsync
```

For a local clone, use the clone's path instead of `aaryan2134/quietsync`. `quietsync-ui` pulls in the core `quietsync` plugin with it. If their org blocks unknown marketplaces (`strictKnownMarketplaces`), stop and tell them to ask their admin.

Then tell your human to run `/reload-plugins` in this session (you can't run slash commands). After that you'll have the `quietsync_*` tools.

## 3. Create their identity

Ask your human for:

- **which kind of group** this is for, and pass it as `profile`:
  - `company`: colleagues at one company on work laptops (high security, records kept)
  - `friends`: friends or classmates (looser, more private)
  - `startup`: a small team on personal laptops (strict and private)

  If Claude Code is signed into a Team or Enterprise plan, say that QuietSync will only let them link with colleagues in their org's QuietSync teams, and suggest `company`.
- **a name**: lowercase letters, digits, `.`, `_` or `-`. Suggest their git email's local part.
- **either** a relay URL (`wss://…`, from whoever runs their team's relay) **or** a code someone sent them (starts with `qs1_`).

Then:

- With a relay URL: call `quietsync_setup(name, relay, profile)`.
- With only a code: call `quietsync_join(code)`. Before setup it answers with the relay the code uses; call `quietsync_setup(name, that relay)`, then `quietsync_join(code)` again.

Each call shows your human a confirm dialog; that's expected.

No relay yet? Point them at [docs/relay.md](docs/relay.md). The quickest test setup is one person running `quietsync relay` behind a tunnel.

## 4. Connect with someone

- **Someone outside their team** (not possible on an org plan; QuietSync will refuse and say so): call `quietsync_invite`, show your human the code, and have them send it over Slack or email. The other person pastes it into their Claude, which calls `quietsync_join`. Afterwards both humans compare the safety number once.
- **Their team:** they paste the team code from their admin; call `quietsync_join(code)`. The team admin's QuietSync admits them within a few minutes.
- **Their own other machine:** they run `quietsync device add` there and paste the code here into `quietsync_join`.

## 5. Check it works

Call `quietsync_status`. It should show their name, the relay as connected, and their contacts. If something's off, run `node <plugin dir>/dist/quietsync.mjs doctor` (the plugin dir is in `claude plugin list --json`, `installPath`).

Tell your human, in a few lines:

- they can now say things like "ask priya's Claude which port payments uses"
- they approve each link and every message that leaves, and secrets are redacted
- who can do what is theirs to change from their own terminal: `quietsync profile`, `quietsync roles`, see [docs/profiles.md](docs/profiles.md) and [docs/policy.md](docs/policy.md)

## Rules for you while doing this

- Don't edit anything under `~/.quietsync` and don't run `quietsync` commands that change trust or policy. QuietSync refuses those anyway.
- Never send an invite code over a link or to anyone but your human.
- Don't add a status line or change settings unless your human asks.

## Undo

```sh
claude plugin uninstall quietsync-ui@quietsync
claude plugin uninstall quietsync@quietsync
claude plugin marketplace remove quietsync
```

Their identity stays in `~/.quietsync` so they can reinstall later. Deleting that folder removes it for good; that's their call, not yours.
