# Private trials with Codex, Gemini CLI and OpenCode

These clients can try QuietSync's existing **messages-only MCP surface**. This is an experimental compatibility path, using the same bridge mode as Claude Desktop. It does not install an agent adapter or the Claude Code UI.

| Capability | Claude Code plugin | Experimental MCP configuration |
| --- | --- | --- |
| Offline questions, replies, inbox | Yes | Offered through MCP; verify in each installed host |
| Human approval of sends | Claude hook/native dialog | QuietSync's local browser approval page, subject to configured modes |
| Live links, file transfer, band and Continue button | Yes | Unavailable |
| Gate the host's other tools after reading a peer message | Claude Code hooks | Unavailable; the host's own permissions and sandbox apply |
| Native prompt, turn and compaction integration | Yes | Unavailable |

An MCP tool appearing in a client is a discovery check. It does not prove an encrypted round trip, a human approval, or enforcement over that client's shell and file tools. Keep these distinctions in test reports and release claims.

## Generate a configuration

Use Node 22 or newer. From this checkout, print the configuration for one client:

```sh
node scripts/client-config.mjs codex --identity-dir /absolute/path/to/trial-identity
node scripts/client-config.mjs gemini --identity-dir /absolute/path/to/trial-identity
node scripts/client-config.mjs opencode --identity-dir /absolute/path/to/trial-identity
```

The command prints a block for review; it does not edit your settings or initialize an identity. Merge the block into the client's documented configuration, preserving other entries:

- Codex: `config.toml`, under `mcp_servers.quietsync`.
- Gemini CLI: `.gemini/settings.json` or user settings, under `mcpServers.quietsync`.
- OpenCode 1.x: `opencode.json`, under `mcp.quietsync`.

The printed command uses the absolute path to the Node executable running the generator and to this checkout's shipped CLI. Regenerate it if either moves. The 120-second tool timeout leaves room for the existing browser approval page; individual calls can still return a waiting response.

Use synthetic identities and sample repositories for the trial. Two different people need separate identity directories. Using one directory in several clients represents one person, not several independent people. Keep these directories outside the repository. Initialize them with the normal QuietSync setup flow and a relay you control; use `--no-plugins` when testing another client so setup does not also install Claude Code plugins.

## Record each stage separately

1. **Discovery:** the real client starts the bridge, lists the expected messages-only tools and calls `quietsync_status`.
2. **Consent:** send a harmless sample question; inspect the exact browser approval text; decline and confirm no question arrives. Repeat and approve.
3. **Round trip:** the second identity reads the question, replies, and the answer reaches the original project. Repeat with the recipient offline, reconnecting to the relay later.
4. **Controls:** send a dummy credential pattern and verify the configured redaction/block behavior; try a live-link tool and confirm it is unavailable. Never use an actual credential for the test.
5. **Host limits:** inspect the client's own sandbox and approval mode. QuietSync cannot provide its Claude-specific tool restrictions through a plain MCP connection.

For every run record client and runtime versions, OS, commit, configuration, which stages passed, which were skipped, and why. Do not record auth tokens, invite codes, real private messages or identity files in committed reports.

## Native adapters

Do not copy Claude's hook JSON directly into these clients. Current Codex documentation says `PreToolUse` does not support `permissionDecision: "ask"`; that response can fail and still continue the tool. Gemini's hook decisions are allow/deny and must be combined with a separately verified human approval path. OpenCode has version-specific plugin and permission APIs. A full adapter must meet [adapters.md](adapters.md), including taint, missing-hook behavior, prompt provenance and a live recorded test.

References, checked 17 November 2026:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex MCP](https://developers.openai.com/codex/mcp/)
- [Gemini CLI MCP servers](https://geminicli.com/docs/tools/mcp-server/)
- [Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode plugin API migration](https://opencode.ai/docs/build/plugins/migrate-v1/)
