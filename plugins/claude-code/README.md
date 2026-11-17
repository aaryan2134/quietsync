# QuietSync (Claude Code plugin)

Links this Claude Code session with a teammate's, an outside contact's, or your own other machine's session. Both humans approve the link, you approve every message your agent sends, secrets are redacted, and peer text is treated as untrusted.

What it adds:

- MCP tools: `quietsync_status`, `quietsync_connect` (one person or a group), `quietsync_send`, `quietsync_accept`, `quietsync_decline`, `quietsync_close`, `quietsync_inbox`, and for setup `quietsync_setup`, `quietsync_join`, `quietsync_invite`
- a `PreToolUse` hook that forces a confirm dialog for every link, accept and send (even in bypass mode), refuses sensitive files and QuietSync's own files, and asks for anything beyond reading while a peer message drives the turn
- `UserPromptSubmit` and `Stop` hooks that track turns and deliver peer messages when nothing else can
- a skill that teaches the agent setup and etiquette

Runs on Node 22+ or Bun. The hooks are a small `sh` script that talks to the session's bridge over a unix socket (about 15 ms per tool call).

Install with `claude plugin install quietsync-ui@quietsync` (brings this one along), or follow [SETUP.md](../../SETUP.md). Policy and roles: [docs/policy.md](../../docs/policy.md).
