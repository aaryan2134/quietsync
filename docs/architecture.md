# Architecture

## Pieces

```
packages/core     protocol, crypto, identity, teams, invites, policy engine, leak scanner,
                  sanitizer, local guards, tool gate, node runtime. No agent specifics.
packages/relay    WebSocket relay (Bun): routing, offline queue, team directory, limits.
packages/cli      quietsync CLI, the per-session bridge (MCP server + control socket),
                  the hooks (sh fast path + Node fallback). Runs on Node 22+ or Bun.
plugins/claude-code      Claude Code plugin: MCP server, hooks, skill.
plugins/claude-code-ui   Claude Code mod: band, buttons, wake-up, /links.
```

**Identity** (`~/.quietsync/identity.json`, 0600). One per person: Ed25519 signing key, X25519 box key, a self-signed card with the name. Devices of the same person share it (`device add/join`).

**Contacts, teams, invites, policy** (`contacts.json`, `teams.json`, `invites.json`, `policy.json`). Plain JSON shared by every QuietSync process of a user, written atomically under a lock file, read through an mtime cache because the gate runs on every tool call.

**Relay.** Dumb on purpose. Authenticates each WebSocket by signature over a nonce, routes sealed envelopes by recipient key, queues for offline recipients, rate-limits, and stores team directory records after checking their signatures. Holds no secrets. See [relay.md](relay.md).

**Node** (`packages/core/src/node.ts`). The runtime every adapter embeds, one per agent session. Owns the relay pool (home relay plus lazy connections to contacts' relays), links, pending requests, the notice queue (what the model will be told), taint, pairing, device and team flows. Enforces roles and limits on both directions.

**Policy engine** (`rules.ts`, `policies.ts`). Resolves what applies to a peer from built-in defaults, the user's layers, the session mode and the admin's managed policy. See [policy.md](policy.md).

**Tool gate** (`policy.ts`, `guard.ts`, `dlp.ts`). A pure function from (session view, tool call) to allow, ask, deny or none. Prepares every outgoing text once (clean, scan, redact) so the dialog and the wire agree.

**Crypto** (`crypto.ts`, `envelope.ts`). Signed, sealed, padded envelopes to each recipient's long-term key; inside a link, a second layer from both sides' throwaway keys with a per-message ratchet. See [protocol.md](protocol.md#link-keys-and-messages).

**Bridge** (`packages/cli/src/bridge.ts`, tools in `tools.ts`, `quietsync mcp`). What an agent launches. An MCP server exposing the `quietsync_*` tools, plus a control socket (`~/.quietsync/run/<session>.sock`, a named pipe on Windows) for hooks, the status line and the UI mod. Issues one-time tickets for gated calls, tracks turns and hook liveness, collects the "looked at" list for send dialogs.

## Session identity

Claude Code passes `CLAUDE_CODE_SESSION_ID` to MCP servers, and hooks get the same id as `session_id`. That id names the control socket, so hooks and the mod find the right bridge without a registry.

## The hook path

Every tool call runs the `PreToolUse` hook, so it has to be cheap:

```
Claude Code ── hook input ──▶ sh hook.sh ── no socket for this session? exit (≈15 ms)
                                   └─ curl --unix-socket … /hook/raw/pre-tool-use ──▶ bridge
                                                            ◀── hook output JSON ──┘
```

`hook.sh` falls back to `node hook.mjs` without curl, on Windows, and for inputs it can't parse with `sed`. If the bridge exists but doesn't answer, it answers "ask". Starting Node or Bun per call costs 120 to 190 ms on a typical laptop; the shell path stays a few ms above starting `sh`.

## Delivery into a session

| path | when | how |
|---|---|---|
| mod | quietsync-ui installed | the mod polls the socket each second and submits one labeled prompt when there's something new |
| channel | org allows channels and the session started with them | `notifications/claude/channel` |
| hooks | always | notices ride on the next `UserPromptSubmit`, or block `Stop` so the agent picks them up before going idle |

Nothing reaches the model until the bridge has seen its hooks run in that session (fail closed). Link requests go to the human only (band, notification, status line); the first message is shown to the model after the human accepts.

## Message flow

```
alice agent ──quietsync_connect──▶ hook ──ask──▶ alice approves ──▶ ticket
            ──bridge──▶ node.connect ──prepare(text)──▶ sealed link.request ──▶ bob's relay ──▶ every bob session
bob band    ──Accept──▶ /human/accept ──▶ claim ──▶ link.accept ──▶ alice; link.claimed ──▶ bob's other sessions
bob node    ──notice (taint)──▶ mod wakes bob's agent ──Read──▶ draft ──quietsync_send──▶ hook shows redacted text ──▶ bob approves
            ──sealed link.msg──▶ alice's relay ──▶ alice node ──notice──▶ alice's agent
```

## Design rules

- the model never holds a capability the human didn't grant in a UI the model can't drive
- one prepared text: what the human approves is byte for byte what's sent
- fail closed: no hook, no ticket, no delivery
- the relay is untrusted for content and only partly trusted for availability
- everything agent-specific stays in an adapter; `core` has no Claude Code imports

Roadmap: [ROADMAP.md](../ROADMAP.md).
