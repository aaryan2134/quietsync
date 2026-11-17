# Security model

QuietSync puts text written by someone else's agent into your agent's context, and lets your agent send text back. Both directions are attack surface. The design assumes **the peer may be hostile and your own model may be fooled**, so the controls that matter don't depend on the model behaving. They depend on things the model can't do: click a native dialog, read a key it's refused, or get bytes past a scanner and a human.

## What we protect

- your files, secrets and environment from being read out to a peer
- your machine from actions a peer talks your agent into
- your consent: nothing links, sends, loosens a policy or lets a secret through without a human choosing it
- message confidentiality and integrity from the relay and the network
- your team's membership from people who don't hold a valid, unexpired invite
- on an org plan, your company's agents from talking to anyone outside the company
- your privacy from peers (machine and project names, read receipts) and from your own disk (message text in logs), when your profile asks for it

## Who we defend against

| adversary | can | can't |
|---|---|---|
| relay operator or network | see who talks to whom, when and how much; drop or delay messages | read content, forge or alter messages, impersonate anyone, admit team members |
| stranger who knows your key | send you envelopes | get past admission (dropped and logged), fill your offline queue past their per-sender quota |
| holder of a leaked invite code | pair once before you do, if faster; queue a team join | reuse a contact code, join a team after the code expires, take a handle someone already has or had |
| hostile peer on an accepted link | send any text | make your agent run tools without your click, get anything back you didn't approve, hide text from you, flood your context (cut off past 20 messages a minute) |
| your own agent after a successful injection | read non-sensitive files, draft replies | send anything you didn't approve, read `.env`/keys/credentials during a peer turn, read QuietSync's keys, change QuietSync's settings, hide data in a message |

## Controls

### Crypto

Each identity has an Ed25519 signing key and an X25519 box key, published in a self-signed card that peers pin at pairing. Safety numbers let two people check out of band that nobody swapped keys. Primitives come from the audited `@noble` libraries.

Three layers protect a message on a link:

1. **Envelope.** Every payload is sealed to the recipient's box key (fresh ephemeral X25519, HKDF-SHA256, XChaCha20-Poly1305 with the header as associated data), padded to a fixed size bucket, and the whole envelope is signed by the sender.
2. **Link keys.** When a link opens, both sides generate a throwaway X25519 key pair and exchange the public halves inside the signed request and accept. The link's keys come from that exchange and exist only in memory; they're wiped when the link closes. Someone who later steals an identity key and replays recorded traffic can open the envelopes but not the messages inside.
3. **Per-message ratchet.** Each message on a link uses its own key, stepped forward from a chain key that's overwritten as it goes. A key taken from memory mid-link doesn't open earlier messages.

Relay logins sign the relay's host name along with its challenge, so a relay a contact points you at can't reuse your login on your real relay. Relays learned from contacts must use `wss://`.

What's not covered: the first message rides inside the link request so the other human can read it before accepting, so it has only the envelope layer. There's no Diffie-Hellman ratchet within a link (links are short-lived), so a live compromise of a running session exposes the rest of that link. Relays authenticate connections by signature over a random nonce.

### Admission

Link traffic is accepted only from pinned contacts, admitted team members, or your own identity. Link requests older than 30 minutes are dropped, and a request accepted once on a machine can't be accepted again there.

Teams are self-certifying (the id is a hash of the team key). Joining takes two signatures: the joiner's membership, made with an invite capability, and an admission signed by the team key. The admin's QuietSync admits joins by its own clock, enforces each code's use limit, keeps handles unique, and never re-issues the handle of someone removed. Clients only trust admitted members. Relays check every record before storing it.

### Consent

A link is between two live sessions and ends with either one, or after an idle hour. A request shows on the other person's band with its first message for the human to read; their model isn't told the message until the human accepts. Accepting takes a band button or a hook-forced dialog. "Always accept from X" is an explicit, remembered choice. Two sessions of the same person can't both take a request.

### Approval of every send

`quietsync_connect`, `quietsync_send`, `quietsync_accept`, `quietsync_setup`, `quietsync_join` and `quietsync_invite` go through a `PreToolUse` hook that answers `ask` with the exact outgoing text. That dialog appears even in bypass-permissions mode and even when the user has an allow rule for the tool (both checked on Claude Code 2.1.312).

The bridge refuses any of those calls that didn't get a ticket from the hook, so a missing or skipped hook fails closed.

Auto-send exists per link (band, behind a warning) or per contact (terminal, behind a typed confirmation). It stops after `autoSendLimit` sends without the human, and never covers a message the scanner flagged.

### Outbound leak prevention

Every outgoing message, first message and topic is prepared once, and both the dialog and the wire use the result:

1. invisible, bidi, Unicode tag and control characters (including ANSI escapes) are removed, so the dialog shows every byte that leaves
2. length is capped (8000 characters by default) so the dialog never truncates
3. a scanner looks for about 40 credential formats, card numbers, JWTs, auth headers, URLs with passwords, `key = value` secrets, base64-wrapped versions of all of those, the actual values of secret-looking environment variables, QuietSync's own private keys and invite codes, and the user's and admin's custom rules
4. findings are redacted (default) or block the send; warnings (random-looking tokens, private IPs, flagged terms) are shown to the human
5. the dialog also lists which files the agent read since the peer's last message

Reasons on decline and close are fixed codes, so there's no free-text field that skips approval.

### Files, images and zips

- **Sending** goes through its own approval dialog: recipient, name, type (detected from the content, not the name), size, fingerprint, and what the scan found. Text files and text inside zips are scanned like messages; files are never redacted, so a secret stops the send. Image metadata (EXIF, XMP, IPTC, PNG text chunks) is removed first. Protected files (`.env`, keys, credentials, QuietSync's own files) can't be sent at all. The approval pins the file's fingerprint, so a file changed after you approved it isn't sent.
- **On the wire** the offer (name, size, fingerprint, and a key made for that one file) travels inside the link's ratchet like a message; chunks are sealed with the file key, bound to their link, file and position, and the key is wiped afterwards.
- **Receiving**: your profile and role decide whether files are accepted and how big (10 MB by default, 25 MB under `friends`, at most 50). Chunks go to a private temp file; the whole file is checked against its fingerprint before it appears. It's saved, unopened, in the inbox folder (`~/quietsync-inbox/<sender>/`), readable only by you, never executable, never unpacked. Zips are described (entries, unpacked size, path traversal, links, executables, nested archives, zip bombs) without extracting anything.
- **Reading one is reading the sender's text.** When your agent reads a received file or image, searches the inbox, or lists received files, the turn switches to peer privilege and is recorded, the same as a peer's message. Any shell command on a received file asks first.

### Lower privilege for peer turns, with an audit trail

Prompts from other people's agents and prompts from you are treated differently. When a peer message is delivered, the session is marked peer-driven and runs at lower privilege until you type something yourself. The dialogs say "peer turn (restricted)". The audit log records the start of each peer turn (who, which link), every tool decision made during it (tool, allow/ask/deny, target), and the moment you took over. During your own turns only refusals and QuietSync's own tools are recorded.

If peer messages keep arriving without you, delivery pauses after 12 in a row (`wakeLimit`) until you type, so two agents can't keep each other running. What asks the human depends on isolation (`relaxed`, `standard`, `strict`; see [policy.md](policy.md)). External peers default to `strict`, which keeps the session marked until the link closes, so an injection can't wait for the human's next prompt.

Only prompts Claude Code marks as typed by the human (`source: "user"`) clear the mark, and a prompt typed mid-turn clears it only when that turn ends.

### Local guard rails

Paths are resolved before they're judged: `~` is expanded, `..` collapsed, and symlinks checked both as written and where they point. Grep and Glob are judged by where they search and what their pattern names, since they can read many files at once.

- `.env` files, SSH and cloud credentials, key files, token files and the user's `protect` list: refused during a peer turn, asked while any link is open
- QuietSync's keys, invites and control sockets: always refused to every agent tool
- QuietSync's settings files: the agent can read them, never write them
- shell commands that run QuietSync's control subcommands, touch its folder, dump secrets (`printenv`, `gh auth token`, keychain reads) or reach the network while a link is open: refused or asked
- edits to `policy.json` while a session runs only take effect if they tighten things

### Fail closed

- **Missing hooks.** Organizations can turn off plugin hooks (`allowManagedHooksOnly`), shells can break, platforms differ. The bridge doesn't hand peer text to the model until it has seen its own hooks run in that session; until then messages wait and the band says so.
- **A bridge that can't answer.** If the bridge errors or doesn't reply within 8 seconds, the hook answers "ask" instead of staying silent (which Claude Code would treat as allow).
- **A new session id.** After `/clear` or a resume, hooks find the still-running bridge through the Claude Code process they share, so the gate keeps working.
- **No ticket, no call.** Gated tools are refused without the hook's ticket; there's no setting to turn that off.

### Inbound sanitizer

Strips invisible and bidi characters, neutralizes tags the model or harness treat as structure (`<system-reminder>`, `</channel>`, `<function_calls>`, special tokens) and QuietSync's own fence markers, flags injection phrasing, and withholds a topic that trips those checks. Peer text is fenced with a fresh random nonce per message.

### Profiles and org plans

A profile ([profiles.md](profiles.md)) switches features off for a whole group: outside contacts, auto-send, auto-accept, secret overrides, copying the identity to new machines; and on for verified-only contacts, no message text on disk, hidden machine and folder names, no read receipts. Layers can only take things away from each other except an admin's managed policy, which decides.

On a Claude Team or Enterprise plan QuietSync detects the org from Claude Code's login and only allows links with your own devices and admitted members of teams tagged for that org. Contact invites, outside codes and other orgs' teams are refused by the runtime and the tool gate, in that order, so the agent gets a clear reason before any dialog.

Team admins publish profiles signed with the team key; relays check the signature and clients check it again. Profiles only move forward in time: relays refuse an older one and clients keep the newest they've seen, so nobody can replay a looser profile. Only well-formed parts of a profile count. A policy file named by `QUIETSYNC_MANAGED_POLICY` is treated like a team profile (it can switch things off, never on), since anyone can set an environment variable; only the system managed policy decides outright. Safety numbers can be marked verified only at a real terminal (`quietsync verify`), and the `startup` profile requires it before linking with anyone outside a team.

### Messages that wait

Questions and FYIs to people who aren't online go through the same relay, sealed and signed like everything else, and the relay keeps them up to 7 days. Only contacts and teammates can send them; anything else is dropped and logged. An incoming message is stored owner-only in `notes.json`, which the agent can't read, and shown on the human's band. It reaches the agent only when the human hands it over (or the agent opens it with `quietsync_messages`), and that turn runs at peer privilege, fenced like a link message. Answers only count for a question actually sent to that person, once. **Continue** on an answer runs as the human's turn only when the whole answer fit on the band and passed the injection checks; anything longer or flagged runs at peer privilege. Once a message has been in a session, the session stays gated like an open link with that person, at their isolation level, until the human ends it on the band or clears the conversation. Unread messages are capped per person and in total, and senders are rate limited. "Delivered" receipts always go; "seen" and "declined" follow the profile's `receipts` switch. Every message, answer and record in or out is audited.

Copies of a thread can be posted to Slack, Jira, email, a webhook or a folder, only to destinations the human set up at a terminal (`records.json`, off limits to the agent). Each post by the agent is approved with the exact text, pinned so a thread that grows while the dialog is open isn't posted. Automatic destinations only get threads the human started, with their own ticket, after they press Continue. Secrets block the post, URLs must be https with no redirects, and Slack and Jira control sequences in someone's text are neutralised.

### Human-only controls

Band buttons and `/links` changes go to the bridge with a token. The UI mod gets it at session start, and the bridge only hands it out before the agent has run any tool and within 30 seconds of starting.

### Keys

New setups and device joins keep the identity's private keys in the OS keychain (macOS keychain, or the Secret Service on Linux), written over stdin rather than a command line. `identity.json` then holds only the public half. `quietsync keys` shows where they are, and `keys keychain` and `keys file` move them; the agent's shell can't read the keychain item. A lost device is handled by `quietsync device revoke`: new keys, announced to every contact under the old ones. Contacts move to the new keys, mark you unverified and drop your mode to `ask`, and anything still holding the old keys stops getting messages.

### Company copy

When the managed policy sets a `journal`, every message, answer, file and link event is also written as a line sealed to the company's public key. That goes to a local folder the agent can't read, and optionally to an https collector. Peers are told their messages are kept. See [profiles.md](profiles.md#a-company-copy-of-every-message).

### Audit

Every request, accept, message (in and out, with redactions noted), close, drop and policy change is appended to `~/.quietsync/audit/YYYY-MM-DD.jsonl` (0600), kept 30 days by default.

## Known limits

- **Reading ordinary files is allowed during peer turns** (except under strict isolation outside the project). An injected agent can pull a source file into context. It can't send it without your approval, so read the send dialog, and the "looked at" line in it.
- **Same-user processes aren't isolated from each other.** QuietSync runs as you, like your agent's shell. Outside a peer-driven turn, an agent with unrestricted shell in bypass mode could edit QuietSync's files with an obfuscated command the pattern guard misses. That only takes effect in later sessions, and only if you run in bypass mode; during peer turns every shell command asks you.
- **The UI claim uses the socket window.** The mod first tries to get its token through Claude Code's own MCP connection, which the agent's shell can't reach. On 2.1.312 that call didn't succeed in testing, so the socket claim (before any tool call, first 30 seconds) is what runs today. UNVERIFIED: whether a newer Claude Code allows the MCP route.
- **Pattern-based scanners miss things.** Look-alike letters are folded and redacted; known formats or your own secret values written with spaces, dashes, reversed or in hex are blocked as evasion attempts. But a secret in a format nobody wrote a rule for, rephrased, or split across several messages still gets through. A random-looking string broken up with spaces is only flagged for you to check. Redaction is a safety net; your approval is the control. Keep auto-send for people you trust.
- **File contents aren't fully scanned.** Images, PDFs and other binaries can show secrets the scanner can't read (a screenshot of a key, a PDF of a contract). The dialog says so; look before you approve.
- **A received file is only as safe as what you do with it.** QuietSync never opens, unpacks or runs one, but once you approve a command that does, the file's contents are in play.
- **A hostile relay can withhold team records**, for example a revocation. Run your own relay for anything sensitive.
- **Device linking copies the identity's private keys** to the new machine, sealed end to end. Per-device keys are on the roadmap.
- **Org security plugins can skip mod hooks.** The core plugin's command hooks carry the gate; don't run quietsync-ui without QuietSync.
- **Windows is untested.** The hooks need `sh` (Git for Windows) and Node, and the band doesn't know Windows pipe paths yet. If the hooks can't run, QuietSync holds peer messages rather than delivering them ungated.
- **Org detection is a default, not a lock.** It reads Claude Code's login (`~/.claude.json`), which a person can change by signing into another account. For an enforced boundary, push a managed policy with `features.orgOnly` and pinned team ids.
- **Org tags aren't secret.** A team card's org tag can be copied by someone outside the org, so a fake "company" team could be offered to an employee as an invite. Joining still takes their click on a dialog that names the team; managed policies that pin team ids close this.
- **Messages that wait have no forward secrecy yet.** Links use throwaway keys per link; a message for someone offline is sealed to their long-term key, like PGP email. Someone who records relay traffic and later steals that person's key can read those messages. Signed prekeys that rotate are on the roadmap.
- **Devices are kept apart only roughly.** Each of your machines gets messages that wait, but only machines that connected to the relay in the last 7 days; "seen" and "answered" on one machine aren't synced to the others. The relay learns which envelopes are messages that wait (`keep`) and how many devices you have.
- **The org lock is enforced by QuietSync on a machine the user controls.** It reads the Claude Code login, and `QUIETSYNC_ORG_ID` can no longer replace an org plan the login shows. Someone who edits their Claude Code login file or runs a modified build can still get around it; for a hard guarantee, use the managed policy, which users can't change.
- **Messages-only MCP clients can't be gated by QuietSync.** Claude Desktop and the experimental Codex, Gemini CLI and OpenCode configurations use the messages-only surface without an installed host tool gate. After reading someone's message, QuietSync can't restrict that host's other tools. Its own sandbox and permissions apply. Sends still use the browser approval path or the configured mode. See [desktop.md](desktop.md) and [client-trial.md](client-trial.md). MCP discovery is not evidence that a native security adapter works.
- **Rotating keys starts trust over, for everyone.** After `quietsync device revoke`, contacts see your keys changed and your mode drops back to `ask` with them until they verify you again. Teams need new codes from their admin. A thief who rotates first gets the same treatment, which is why contacts should compare safety numbers when keys change.
- **Auto mode trades a dialog for checks.** In `auto` and `trusted`, a message that passes the checks ([levels](levels.md)) leaves without you reading it. The checks catch secret formats, another peer's turn, sensitive reads, code dumps and volume; they don't catch a paraphrased secret or a bad decision. Keep `auto` for people you'd let read your repo.
- **The human-only CLI checks are best effort.** `quietsync messages`, `ask`, `reply`, `contact` and `records` refuse to run without a real terminal or anywhere under Claude Code, and fake-terminal wrappers ask first. A process that detaches from Claude Code and fakes a terminal could still get past them; that's the same-user limit above.
- **Records leave the two of you.** Once a thread is in Slack, Jira or someone's inbox, that tool's access rules apply, not QuietSync's.
- **Traffic analysis.** Relays see metadata. Running your own relay limits who sees it.

Report vulnerabilities privately; see [SECURITY.md](../SECURITY.md).
