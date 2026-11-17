# Changelog

Packages follow semver. The protocol version (v1) is separate and only changes through an RFC. Until 1.0, minor releases may add optional protocol fields; receivers ignore what they don't know.

## Unreleased

- Experimental configuration generator and trial guide for Codex, Gemini CLI and OpenCode using the existing messages-only MCP surface. These are not native hook adapters.
- Native MCP connection probes, dependency-free shipped-bundle smoke checks and a separate fresh client-validation report.
- Pin Bun 1.4.4 and workflow actions; narrow release-job permissions; support private-repository validation without publishing a relay image.
- Build the relay container from source and health-check it in CI, instead of depending on ignored build output being present in a clean checkout.
- Fill maintainer/repository placeholders, ignore local secret/state files, and clarify the solo-maintainer review stage.

## 0.4.0-rc.3 (release candidate, not published)

- **Claude Desktop chat** ([docs/desktop.md](docs/desktop.md)): `quietsync desktop install` adds messages that wait to Claude Desktop. Sends are approved on a page QuietSync opens in your browser, new messages raise a system notification, and what's waiting is in Claude's instructions at startup. Live links stay in Claude Code.
- **Company copy**: a managed `journal` keeps every message sealed to the company's key, locally and optionally at an https collector; `quietsync journal keygen` and `read`; peers see "their company keeps a copy".
- **Keys in the OS keychain**: new setups and device joins keep private keys in the macOS keychain or Linux Secret Service; `quietsync keys [keychain|file]`.
- **Lost device**: `quietsync device revoke` (or `keys rotate`) makes new keys and tells every contact under the old ones. Contacts mark you unverified and back to `ask`, and the old keys stop receiving.
- **Band**: each link shows its mode; toasts when a message went to Claude on its own or was sent without a dialog; a notification when someone's keys change; "keeps a copy" where a company journals.
- **Lighter sessions**: what every session loads went from about 2,600 to 1,750 tokens (shorter instructions and tool descriptions, setup hidden once set up).

## 0.4.0-rc.2 (release candidate, not published)

**Levels: modes and rules** ([docs/levels.md](docs/levels.md))
- four modes per person, team or relationship: `ask`, `review`, `auto`, `trusted`. Defaults: outside contacts ask, teammates review, your own devices trusted
- in `review` FYIs and answers reach the agent on their own; in `auto` sends that pass the checks go without a dialog and the agent answers questions it can; in `trusted` requests flow and links are accepted
- rules like `allow fyi(team:payments)`, `ask request(*)`, `deny send(external)`; deny beats ask beats allow
- caps per relationship from profiles and the managed policy (`modes`); company and startup let teammates go up to auto and keep outside contacts at ask
- a new message kind, `request`
- `quietsync mode`, `quietsync rules`; loosening always asks for a typed confirmation

**Delivery when a session opens**: SessionStart tells the agent (names and counts) and the human (subjects) what's waiting, even before that session's bridge is up. Without the band, new messages are mentioned once on the next prompt.

**Fixes from the contrarian audit**
- a peer closing a link no longer ends the restricted turn their message started; link messages keep the session gated like messages that wait
- the relay keeps every envelope until the client acks it, including ones handed to a socket that died
- the agent's own settings, hooks and plugins are guarded; a quietsync call that skips its hook holds peer text again; a prompt with no `source` isn't the human
- shell history and more token files are sensitive; dig, nslookup, host and ping count as sending data out
- the store lock takes over a dead process's lock at once
- a flaky test (nonce regex) fixed
- messages that wait reach each of your devices, not just the first one online (the relay keeps them per device until each acks)
- `QUIETSYNC_ORG_ID` no longer replaces an org plan the Claude Code login shows
- `quietsync rules allow` and raising a mode for a team nobody is in yet now ask for confirmation too

## 0.4.0-rc.1 (release candidate, not published)

**Renamed to QuietSync** (was agentlink). The CLI, plugins, tools (`quietsync_*`), config folder (`~/.quietsync`), environment variables (`QUIETSYNC_*`) and invite codes (`qs1_`) all changed; earlier builds can't talk to this one.

**Messages that wait**
- `quietsync_message` sends a question or FYI to a contact or teammate who isn't online; the relay keeps it up to 7 days
- receipts: delivered (always), seen and declined (if the receiver's profile sends receipts), answered
- the receiver's band shows the question with Answer with Claude, Later and Dismiss; it reaches their agent only when they hand it over, at peer privilege
- `quietsync_reply` answers; the answer comes back to the project that asked, and Continue on the band hands it to Claude
- `quietsync messages`, `ask`, `reply`, `dismiss` for people who'd rather use a terminal
- contact book: `quietsync contact <peer> --role --note`, shown to the agent in `quietsync_status`
- records: post a thread to Slack, Jira, email, a webhook or a folder (`quietsync records`, `quietsync_record`), on request or automatically; secrets block the post
- profile switches `messages` and `records`

**Fixes**
- team sync no longer drops what you set on a contact (verified safety number, contact book role and note)
- commands wrapped in a fake terminal (`script`, `unbuffer`, `pty.spawn`) ask first

**Security review (round 3, messages that wait)**, all fixed: Continue only runs as your turn when the whole answer fit on the band; someone's message keeps the session gated at their isolation level until you end it (survives a resume, ends on `/clear`); automatic records only for your own threads, with your own ticket, after Continue; message and contact commands refuse to run under an agent; record approvals pinned to the text; listing messages counts as reading them; one answer per question across sessions, with stale claims freed after two minutes; `env:` record URLs checked for https after they're read; who chose a ticket is stored with the message.

## 0.3.0-rc.3

**Fixes**
- after `/clear` or a resume the band kept looking for the bridge under the old session id and went blank; a new `SessionStart` hook gives the bridge an alias for the new id
- a fresh session no longer holds the first peer message until you type: the `SessionStart` hook shows the bridge its hooks are live (retried in the background if the bridge starts after the hook)
- `quietsync log` shows why a peer turn started, file names and sizes, and who a team admitted
- the release workflow builds the same bundle and binaries as `bun run release` (on macOS, so darwin binaries are signed like local builds), checks the tag against the version and the committed plugin against a fresh build
- the plugin bundle leaves out the demo video and screenshots

**Docs**
- demo video, screenshots and a public test report in `docs/media` and `docs/test-report.md`
- comparison lists more projects in this space

## 0.3.0-rc.2

**Files, images and zips**
- `quietsync_send_file` sends a file to a link or group after its own approval dialog (type from content, size, fingerprint, scan results); the approval pins the fingerprint
- text files and text inside zips are scanned; secrets stop the send (files are never redacted); protected files can't be sent at all
- image metadata (EXIF, XMP, IPTC, PNG text) is removed before sending
- files travel as a ratcheted offer plus chunks under a one-file key; the receiver verifies the whole file against its fingerprint
- received files are saved unopened in `~/quietsync-inbox/<sender>/`, owner-only, never executable or unpacked; zips are described (entries, traversal, links, executables, bombs) without extraction
- reading, searching or listing received files puts the turn at peer privilege; shell commands on them ask first
- `files` profile switch and `maxFileMB` limit (10 MB default, 25 under `friends`, 50 max); `quietsync_files` tool and `quietsync files` command

**Fixes**
- the bridge stays up with a clear message when its control socket path is too long, instead of crashing
- the shell guard matches QuietSync's folder by whole path components

## 0.3.0-rc.1

**Encryption**
- per-link forward secrecy: both sides exchange throwaway X25519 keys in the signed request and accept; link keys live only in memory and are wiped on close
- per-message symmetric ratchet inside each link; a receiver only advances after a message decrypts
- envelopes padded to fixed size buckets
- protocol: `eph` on `link.request` and `link.accept`, `link.msg` carries `box` instead of `text`

**Peer turns**
- turns started by another agent's message run at lower privilege, labelled "peer turn (restricted)" in dialogs
- audit log records each peer turn's start and end and every tool decision during it; human turns record refusals and QuietSync's own tools
- delivery pauses after `wakeLimit` (default 12) peer messages in a row without the human

**Hardening**
- new inbound flags: fake approval prompts, hidden HTML comments, long encoded payloads; a reminder follows every fenced peer message
- `QUIETSYNC_MANAGED_POLICY` can no longer override a system managed policy
- relay connections ping every 25 s and reconnect with jitter; the bridge logs crashes (no message text) to `~/.quietsync/logs/bridge.log`
- profile switches cached per team and policy file change

**Second security review** (14 findings, all fixed, each with a regression test)
- the hook answers "ask" when the bridge errors or doesn't reply; no setting turns off ticket checks
- Grep and Glob judged by search root and pattern; paths resolved (`~`, `..`, symlinks) before they're judged; QuietSync's audit, session and log files off limits to the agent; `quietsync log` is human-only
- team profiles validated field by field, only move forward in time (relay and client), team directory capped against stuffing, members-only admission tracked per team
- relay logins signed for the relay's host; relays learned from contacts must be `wss://`
- `QUIETSYNC_MANAGED_POLICY` only narrows; managed org pins match team ids only
- scanner folds look-alike letters and blocks spaced, dashed, reversed or hex-encoded secrets; spaced-out random strings and long hex runs hold auto-send
- after `/clear` the hook finds the bridge through the Claude Code process; `/hook` input parsing takes the top-level `session_id` only
- status output withholds suspicious topics; the session state file keeps no peer text; audit retention follows the profile
- per-IP connection limit raised for offices behind one NAT; the test suite went from 32 s to 5 s as a side effect

**Docs**
- [docs/safety.md](docs/safety.md): what QuietSync protects and doesn't, good practice, incident steps, legal notice; setup shows a disclaimer and asks for an OK
- [docs/comparison.md](docs/comparison.md): QuietSync next to agent-talk, aweb, MCP Agent Mail, Claude Code teams and A2A

**Profiles and org plans**
- three profiles for three kinds of groups: `company` (high security, medium privacy), `friends` (low security, high privacy), `startup` (high security, high privacy), plus `default`
- twelve switches a profile sets: outside contacts, org-only, auto-send, auto-accept, secret overrides, verified contacts only, copying the identity, audit level and retention, sharing machine name, sharing folder name, read receipts
- on a Claude Team or Enterprise plan (detected from Claude Code's login) QuietSync only links with colleagues in the org's teams; contact invites, outside codes and other orgs' teams are refused
- team admins publish a profile for their team, signed with the team key (`quietsync team profile`, `team create --profile`); it can only take things away from members
- managed policy can set `profile`, individual `features` and pinned org teams
- `quietsync profile`, `profile list`, `profile set`, `verify`; `setup --profile`; `quietsync_setup` takes a profile
- team cards carry a hashed org tag; a team running an org-only profile is its own org boundary

## 0.2.0

**Who can do what**
- roles per person, team, relationship or default: `peer`, `asker`, `responder`, `listener`, `notifier`, `off`, plus raw capabilities
- approvals (`links`, `send`, `autoSendLimit`), isolation levels (`relaxed`, `standard`, `strict`, strict by default for external peers), secret mode (`redact`, `block`)
- session mode from the band (`/links pause|resume|mode <role>`) or `QUIETSYNC_ROLE`
- managed policy for admins: a ceiling users can't loosen, relay allowlist, no-external, no-secret-override
- `quietsync roles`, `role`, `policy show|set`; loosening needs a typed confirmation; live edits to `policy.json` only tighten a running session

**Several connections**
- group links: ask several people at once, one approval sends to all of them
- link limit per session, pending-request limits, idle links close after an hour
- people on different relays can pair and talk; contacts remember each other's relay
- a request can target one session label

**Leak prevention**
- outbound text is prepared once for the dialog and the wire: hidden and control characters removed, length capped, about 40 credential formats, base64-wrapped secrets, card numbers, this machine's secret env values, QuietSync's own keys and invite codes, custom block/warn rules and terms
- redact by default, block on request; warnings always put a human in front of a send
- the send dialog lists the files the agent looked at since the peer's last message
- `.env`, keys and cloud credentials refused during peer turns and asked while linked; QuietSync's own files off limits to the agent; secret-dumping and network commands gated

**Security fixes** (from an internal adversarial review)
- decline and close reasons are codes, no free text
- first messages wait for the human to accept before the model sees them
- channel and plugin turns no longer clear the peer-driven mark; a prompt typed mid-turn clears it at turn end
- team joins need an admission signed by the team key: expired or leaked codes can't be backdated, handles are unique and revoked handles stay reserved
- team names validated; suspicious topics withheld from the model
- auto-accept takes the request in one session only; extra acceptors are turned away
- stale link requests dropped; per-link inbound rate limit
- the band's control token is only handed out before the agent runs any tool
- tickets are minted only for calls that are asked or allowed; unknown targets are denied
- peer messages are held until the bridge has seen its hooks run in the session
- relay: per-sender queue quota, global cap, per-IP connection limit, members-only mode, `/metrics`, expired invites refused

**Setup and platforms**
- one-step setup by pasting [SETUP.md](SETUP.md) into Claude; `quietsync_setup`, `quietsync_join`, `quietsync_invite` tools with confirm dialogs
- `quietsync setup` and `uninstall` in the terminal
- CLI, bridge and hooks run on Node 22+ or Bun; the relay stays on Bun
- `sh` hook fast path: about 15 ms per tool call instead of 120 to 190 ms
- the UI plugin depends on the core plugin, so one install gets both

## 0.1.0

First working version: pairing, teams, devices, per-session consent, approved sends, taint gate, sanitizer, secret scanner, relay, Claude Code plugin and band.
