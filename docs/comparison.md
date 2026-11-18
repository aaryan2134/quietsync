# How QuietSync compares

Several tools connect AI agent sessions. They make different trade-offs: some aim for agents talking unattended, some for one person's own sessions, some for servers. QuietSync is built for **people** whose agents talk, with each person in control and the other side treated as untrusted. This page is based on each project's own README, docs and source as of October 2026; corrections welcome.

## Next to Slack's own agents

Slack is turning into an agent workspace, with agents that summarize, prepare meetings and, by Salesforce's own pitch, negotiate with other people's agents on your behalf. That keeps the conversation inside Slack, on Slack's servers, readable by the workspace. QuietSync starts from the other end: the agent you already work with, in the tool you already work in, talking end to end encrypted to the other person's agent, with each person approving what leaves. Slack, Jira and email stay useful as the written record, and QuietSync posts threads there when you want it to ([messages.md](messages.md#keeping-a-written-record)).

## At a glance

| | QuietSync | agent-talk (retalk) | aweb | MCP Agent Mail | Claude Code agent teams / cross-session | A2A |
|---|---|---|---|---|---|---|
| connects | different people, your own devices; live links and messages that wait | different people and machines | sessions, machines, orgs | agents on one host (remote via token) | one person's own sessions | services across orgs |
| encryption in transit | end to end by default | end to end (Olm) | plaintext by default, end to end opt-in | none beyond transport | local socket; cross-machine via Anthropic | TLS |
| forward secrecy | per link and per message (ephemeral X25519 + ratchet); a link's first message and messages that wait not yet | yes, Double Ratchet with post-compromise recovery | no ratchet | n/a | n/a | n/a |
| who sees content | only the two sessions | only the two sides | server unless `--e2ee` | the server | Anthropic for cross-machine | each service |
| peer authentication | pinned keys, safety numbers, team key admission | fingerprint verify, key pinning | signed DIDs, DNS-rooted team certs | shared bearer token | your account | OAuth, mTLS, API keys |
| other human accepts the link | yes, every link | no (their agent redeems the invite) | contact policy | agent-to-agent | n/a (same user) | implementation |
| you approve each send | yes, even in bypass mode; fails closed | no, autonomous by design | no | no | can ask before leaving the machine | implementation |
| prompt injection handling | sanitizer, nonce fences, lower-privilege peer turns, sensitive files refused | not documented | not documented | XSS sanitizing only | marked "not from you", can't approve or change config | not specified |
| secret leak prevention | ~40 formats, env values, own keys, custom rules, redaction | none | none | scrubs exports only | none | not specified |
| audit | local, per turn and per tool, privacy levels | local history | server metadata | Git archive of all messages | transcripts | per deployment |
| org controls | org-plan lock, signed team profiles, managed policy, relay allowlist | none | team authority | contact policies, overseer UI | managed deny rules | per deployment |
| maturity | 0.x, Claude Code only, no audit | young, 6 agent CLIs | active, federated | popular, Python version in maintenance | product feature | v1.0 standard |
| license | Apache-2.0 | MIT | MIT | MIT with a rider on AI vendors | proprietary | Apache-2.0 |

## Where QuietSync is stronger

- **Both humans stay in the loop.** The other person accepts each link on their screen, and you see the exact text of every message before it leaves. That holds in bypass-permissions mode, and if the approval hook is missing, sends fail instead of going through. agent-talk recommends running agents in auto mode and its send step has no confirmation.
- **It assumes the other agent is hostile.** Peer text is sanitized and fenced, a turn it starts runs at lower privilege with a full audit trail, sensitive files are refused, and the agent can't touch QuietSync's own settings. None of the other tools that connect different people document injection defenses.
- **It stops secrets leaving.** Outgoing text is scanned for credential formats, the actual secret values on your machine and your own rules, and redacted before you approve. Others don't scan live messages.
- **Encrypted by default, end to end.** aweb is server-readable unless you opt in; Agent Mail and Claude Code's cross-machine path have no end-to-end layer.
- **Organizations can set the rules.** Org-plan lock, team profiles signed by the team key, managed policy for IT, members-only relays.
- **Per-person direction.** You can make someone ask-only, answer-only, receive-only or send-only.

## Where others are stronger

- **Forward secrecy depth.** agent-talk's Olm sessions do a Diffie-Hellman ratchet on every round trip, so they recover after a key compromise. QuietSync's per-link keys and per-message ratchet protect past messages, but not future ones after a live compromise, and the first message on a link (shown to the other human before they accept) is protected only by the recipient's long-term key.
- **Maturity and reach.** A2A is a 1.0 standard; agent-talk supports six agent CLIs; aweb federates. QuietSync is 0.x, Claude Code only and tested live only on macOS. It has a [recorded independent Codex review](security-review-2026-11-18.md), but no external human security audit.
- **Coordination features.** Agent Mail has file leases, aweb has tasks and presence, agent teams share a task list. QuietSync only does messaging.
- **Unattended use.** If you want agents to work through the night without a person, approval on every send is friction. QuietSync allows auto-send, but caps it on purpose.
- **Identity.** aweb's DNS-rooted identities support rotation. QuietSync copies keys between your own devices and has no rotation yet ([ROADMAP.md](../ROADMAP.md)).

## Also in this space

Projects we know of but haven't reviewed in depth. The one-line summaries are from each project's own description, October 2026.

- **hcom** (github.com/aannoo/hcom): agents in different terminals message, watch and spawn each other, with a relay across devices. Works with several agent CLIs. Built mainly for one person's agents.
- **agmsg** (github.com/fujibee/agmsg): messaging between different vendors' agent CLIs (Claude Code, Codex, Gemini, Copilot) on one machine.
- **ccbridge** (github.com/sourabhnirvani/ccbridge): two people's Claude Code agents talk through an MCP bridge. Started September 2026.
- **AI-Connect** (github.com/Peuqui/AI-Connect): a self-hosted bridge for agents across machines, people and accounts.

If you maintain one of these and something here is wrong, open an issue.

## Sources

- agent-talk: github.com/xhluca/agent-talk (README, SECURITY.md, skills), github.com/xhluca/retalk (docs/olm.md)
- Olm: gitlab.matrix.org/matrix-org/olm (docs/olm.md)
- aweb: github.com/awebai/aweb (README, docs/trust-model.md, docs/e2e-messaging-contract.md)
- MCP Agent Mail: github.com/Dicklesworthstone/mcp_agent_mail
- Claude Code: code.claude.com/docs/en/agent-teams, code.claude.com/docs/en/cross-session-messaging
- A2A: a2a-protocol.org/latest/specification
