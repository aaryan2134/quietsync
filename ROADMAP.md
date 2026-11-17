# Roadmap

Where it's going: day-to-day coordination between people moves to their agents. Developers first, with live links for working together and messages that wait for everyone else; then designers, PMs and managers as their agents catch up. Chat, standups and status tickets shrink to the record and the decisions that really need people.

Rough order, not dates. Each item links to an issue or RFC once someone picks it up. Anything that changes the protocol or the security model needs an [RFC](rfcs/README.md) first.

## 0.4: messages that wait (in progress)

- done: questions and FYIs to people who aren't online, with delivered, seen and answered receipts; answers come back to the project that asked; contact book with roles; records in Slack, Jira, email, webhooks and folders
- signed prekeys that rotate weekly, so messages that wait get forward secrecy like links
- structured asks: a question with choices the other person answers from the band in one press
- "who should I ask": let a team admin publish roles in the team directory, not just each person's own contact book
- reaching people who aren't on QuietSync yet: deliver the question as a Slack DM or email with a reply link

## 0.5: ready for teams to try

- publish the repo, the marketplace and a relay image (GHCR)
- Linux and Windows: CI on all three, Windows pipe support in the band, a tested Windows hook path
- `quietsync setup` from npm (`npx quietsync setup`) for people who start in a terminal
- a hosted demo relay for trying it out, with members-only mode and abuse limits
- structured asks: a question with choices the other human can answer from the band in one press
- per-link transcripts the human can open (`/links show <id>`)

## 0.6: more agents, more people

- adapters: Codex CLI, Gemini CLI, opencode, each with its own gate and a recorded test run ([docs/adapters.md](docs/adapters.md))
- a conformance suite any adapter can run against a local relay
- agent-neutral skill text, so every adapter teaches the same etiquette
- the Claude desktop and web apps, so designers, PMs and managers can answer from where they already work

## 0.7: stronger identity

- per-device keys cross-signed by a person key, so adding a laptop doesn't copy secrets and losing one can be revoked
- key rotation with continuity (contacts accept a new key signed by the old one)
- human-presence check for policy changes (Touch ID, Windows Hello, a hardware key) instead of a TTY prompt
- the UI token over Claude Code's own MCP connection once that's allowed for mods

## 0.8: organizations

- multi-admin teams, admin handoff, and team-wide policy published by the team key ("teammates may auto-answer questions tagged `oncall`")
- relay federation for orgs that want their relays to only talk to approved relays
- SSO-bound team membership (OIDC) as an optional admission check
- audit export to a SIEM, with message bodies optional

## 1.0

- protocol v1 frozen, with a compatibility test suite
- third-party security review of crypto, gate and scanner
- stable plugin and CLI interfaces

## Ideas, not planned

- shared scratchpads (a small doc both agents can edit, each edit approved)
- linking an agent to a team channel instead of one person
- scanning outgoing messages with a local model in addition to patterns

Want to work on one of these? Comment on its issue, or open one.
