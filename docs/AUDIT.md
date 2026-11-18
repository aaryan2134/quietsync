# Security audit guide

For anyone auditing QuietSync, human or agent. It says what QuietSync promises, where the code for each promise lives, what has already been found and fixed, and where we think the remaining risk is. Please try to break every claim here.

## What QuietSync is

Each person's AI coding agent (Claude Code today) runs a small MCP server, the **bridge**, which talks to a **relay** over WebSocket. Agents of different people exchange messages over **links** that both humans approve. Text from the other side lands in your agent's context, so the design assumes the peer is hostile and your own model can be prompt-injected.

## Claims to verify

| # | claim | where |
|---|---|---|
| C1 | Only the two endpoints can read link messages; the relay and network can't read or forge them | `packages/core/src/crypto.ts`, `envelope.ts`, `node.ts` (`linkKeys`, `ratchet`, `boxLinkText`) |
| C2 | Compromise of a long-term key later doesn't reveal recorded link messages (except a link request's first message) | `crypto.ts` `linkKeys`/`ratchet`; `node.ts` connect, accept, link.msg, wipe |
| C3 | Nothing links without the other human accepting | `node.ts` `onLinkRequest`, `accept`; `bridge.ts` `/human/*`; UI `register.tsx` |
| C4 | Every outgoing message, first message and topic is shown to the human exactly as sent, unless they turned on auto-send | `policy.ts` `decideToolUse` (connect/send), `dlp.ts` `prepareOutbound`, `bridge.ts` tickets |
| C5 | Gated tools fail closed: no hook decision, no call; a bridge that can't decide asks | `bridge.ts` (`GATED`, tickets, `/hook/raw`), `assets/hook.sh`, `hook.ts` |
| C6 | Secrets in known formats, this machine's secret env values and QuietSync's own keys don't leave unredacted; disguised forms are blocked | `dlp.ts` |
| C7 | A turn started by a peer message runs at lower privilege: only reads run freely, sensitive files are refused, everything is audited | `policy.ts`, `guard.ts`, `bridge.ts` (taint, turn tracking, audit) |
| C8 | The agent can't change QuietSync's trust, policy or keys (files, CLI, control socket) | `guard.ts` `CONTROL`, `QUIETSYNC_DIR`, `pathGuard`; `policies.ts` (live edits only tighten); `bridge.ts` claim window |
| C9 | Peer text reaching the model is sanitized and fenced with a fresh nonce | `sanitize.ts`, `frame.ts` |
| C10 | Team membership needs the team key's admission; expired or leaked codes can't be replayed; handles stay unique; team profiles can't be rolled back | `team.ts`, `node.ts` team methods, `relay/src/index.ts` `dirPut` |
| C11 | On a Claude Team/Enterprise plan, only colleagues in the org's teams can link; only the system managed policy can lift that | `profiles.ts` `detectOrg`, `policies.ts` `admission`/`sources`, `rules.ts` `loadManagedPolicy`/`loadEnvPolicy` |
| C12 | A relay login is only valid for that relay | `relay-client.ts` `relayAuthBytes`, `relay/src/index.ts` |
| C13 | Profiles combine so that teams and env-supplied policies only narrow; an admin's managed policy decides | `profiles.ts` `resolveFeatures`, `policies.ts` |
| C15 | A message that waits reaches the recipient's agent only when their human hands it over or the agent opens it, and that turn runs at peer privilege; only contacts can send one; an answer only counts for a question actually sent to that person, once; Continue runs as a human turn only for answers that fit on the band and didn't trip the injection checks; after a message has been in a session, it stays gated at the sender's isolation until the human ends it | `node.ts` `onNote`, `openNote`, `takeAnswer`, `onNoteAck`; `bridge.ts` `/human/note-*`, `bandNotes`; `guard.ts` (`notes.json`) |
| C16 | Records go only to destinations the human configured at a terminal, with the exact text approved (or the destination marked automatic), secrets blocked, https only, peer markup neutralised, and each automatic record posted once | `notes.ts` `postRecord`, `checkDest`; `bridge.ts` `recordTo`, `autoRecord`; `main.ts` `records`; `policy.ts` `record` |
| C17 | Nothing goes out or reaches the agent without a person beyond what the sender's mode and rules allow; an allow rule never passes the cap; modes, caps and rules only loosen with a typed confirmation at a real terminal; auto sends still stop for scanner findings, another peer's turn, a sensitive read since the human typed, big code, length and the hourly limit; each message is applied once, answers only in the asking project | `levels.ts`; `rules.ts` `clamp`, `withFlow`; `policies.ts` `resolve`, `rules`; `policy.ts` `holdAuto`, `message`, `reply`, `send`; `node.ts` `onNote`, `applyNote`; `main.ts` `applyFileChange`, `fileLoosens` |
| C18 | Peer text can't switch the gate off: the agent can't edit its own settings, hooks or plugins during a peer turn (asks while linked), a quietsync call that skips its hook holds peer text again, a prompt with no `source` doesn't count as the human, and a peer closing the link doesn't end the restricted turn | `guard.ts` `AGENT_CONFIG`; `policy.ts` `agent-config`; `bridge.ts` `hookSeen`, `/hook/user-prompt-submit`; `node.ts` `markDelivered` |
| C19 | With a managed `journal`, every message, answer, file and link event is kept sealed to the company key, readable only with its private key, whatever the user's audit level; the agent can't read the journal folder; peers are told | `journal.ts`; `store.ts` `tee`; `node.ts` constructor and `shared`; `guard.ts` (`journal`) |
| C20 | Private keys in the keychain never touch disk or a command line; the agent can't read the item; a key rotation moves contacts to the new keys only when signed by the old ones, resets them to unverified and `ask`, and the old keys stop receiving | `keystore.ts`; `store.ts` `saveIdentity`, `identity`; `node.ts` `rotateKeys`, `onRotate`; `guard.ts` `QUIETSYNC_KEYCHAIN` |
| C21 | In Claude Desktop (no hooks), nothing gated goes out without the browser approval page or a mode that allows it; the page only answers its own host, origin and secret path; live links aren't offered | `bridge.ts` `approveInBrowser`, `startApprovals`, `DESKTOP_TOOLS` |
| C14 | A file is sent only as approved (fingerprint pinned), protected files never; received files are verified, quarantined unopened and owner-only, never unpacked; reading one runs at peer privilege | `files.ts`, `node.ts` `sendFile`/`onFileOffer`/`onChunk`/`finishTransfer`/`touchPeerContent`, `policy.ts` `send_file`, `guard.ts` inbox |

The threat model and known limits are in [security.md](security.md). Anything listed there as a known limit is out of scope unless you find it's worse than stated.

## Trust boundaries

```
peer's agent ──(relay, untrusted)──▶ your node ──notice──▶ your model ──tool call──▶ PreToolUse hook ──▶ bridge gate
                                         ▲                                                   │
                         band / CLI (human-only, token or TTY)                       ask / deny / allow
```

- **Relay**: untrusted for content, partly trusted for availability.
- **Peer**: authenticated (pinned key or team admission), never trusted for content.
- **Your model**: trusted to call tools, not trusted to follow rules once injected.
- **Same-user processes**: not separated from the agent's shell (documented limit).

## Already found and fixed

Four internal adversarial review rounds are summarized in [CHANGELOG.md](../CHANGELOG.md) and [test-report.md](test-report.md#security-review-results). They were AI-agent reviews, not independent human audits. The separate pre-public Codex review and its scope are recorded in [security-review-2026-11-18.md](security-review-2026-11-18.md). Re-checking those fixes is a good start.

## Where we'd look next

- **Hook input parsing** (`assets/hook.sh` sed, `hook.ts`): inputs Claude Code might send that we haven't seen; timing of the 8 s timeout.
- **Path guard** (`guard.ts`): case-insensitive filesystems, unicode normalization of paths, hard links, `/proc`, Windows paths.
- **Shell guard**: anything that runs QuietSync's CLI, touches `~/.quietsync` or prints secrets during a peer turn without matching a pattern. During peer turns every shell command asks anyway; outside them the guard is best effort.
- **Scanner**: formats and encodings we don't cover; false negatives matter more than false positives.
- **Bridge state machine**: taint set and cleared across `/clear`, resume, compaction, subagents, queued prompts, the mod and hooks both reporting. The `SessionStart` hook creates socket aliases for new session ids (`bridge.ts` `sessionAlias`) and marks hooks live: can anything other than Claude Code's hook use that to point a session's UI at the wrong bridge, or release held peer messages early?
- **Relay**: resource exhaustion, SQLite growth, members-only bypasses, directory consistency.
- **Crypto**: nonce handling, key wiping (JS can't guarantee it), ratchet skip limits, the first-message gap.
- **UI mod** (`register.tsx`): anything that lets text from a peer act as a button press or reach `/human/*`.
- **Messages that wait** (`node.ts` notes section, `notes.ts`): races between several sessions sharing `notes.json`, receipts out of order, a peer replaying or forging `replyTo`, anything that puts peer text in front of the model without taint, the Continue button's human privilege.
- **Records** (`notes.ts`): Jira path and markup, Slack escaping, mailto, webhook redirects, secrets in the thread that the scanner misses.
- **Files** (`files.ts`): the zip reader on hostile archives (zip64, overlapping entries, data descriptors), JPEG/PNG metadata stripping on malformed images, inbox name collisions and symlinks, chunk ordering and duplicate handling, memory use on large files.

## How to run things

```sh
bun install && bun run build && bun test
bun audit
gitleaks detect --no-git --source .
```

Probe scripts can import `packages/core/src/index.ts` directly with Bun. `packages/relay/test/e2e.test.ts` shows how to start relays and nodes in-process; `packages/cli/test/bridge.test.ts` shows how to drive the built bridge and the hook like Claude Code does.

## Reporting

Write each finding as: severity, file:line, a concrete attack, whether you reproduced it, and a suggested fix. Before the repo is public, send findings to the maintainer directly; after, use private vulnerability reporting ([SECURITY.md](../SECURITY.md)).
