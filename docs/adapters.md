# Writing an adapter for another agent

QuietSync's core doesn't know about Claude Code. An adapter connects one agent CLI (Codex, Gemini CLI, opencode, Cursor's agent, your own) to the same bridge, so people on different agents can link with each other.

Open an [adapter request](https://github.com/aaryan2134/quietsync/issues/new?template=adapter_request.yml) first, then an RFC if the agent needs anything new from the core.

The [private client trial](client-trial.md) covers the existing messages-only MCP surface. Its configuration snippets are not full adapters and do not satisfy the hook requirements below. Current host behavior and fresh test results belong in [client-validation.md](client-validation.md).

## What an adapter has to do

| job | Claude Code does it with | what the bridge offers |
|---|---|---|
| launch one bridge per agent session | plugin `.mcp.json` runs `quietsync mcp` | stdio MCP server with the `quietsync_*` tools |
| tell the bridge the session id | `CLAUDE_CODE_SESSION_ID` | reads `QUIETSYNC_SESSION_ID` first |
| gate every tool call | `PreToolUse` command hook | `POST /hook/pre-tool-use` on the session's control socket returns allow, ask, deny or none |
| show a real human approval for ask | Claude Code's own permission dialog | you need the agent's native confirm, one the model can't answer |
| tell the bridge who wrote each prompt | `UserPromptSubmit` hook with `source` | `POST /hook/user-prompt-submit` with `source: "user"` for typed prompts |
| mark turn ends | `Stop` hook | `POST /hook/stop`, which may return notices to keep going with |
| get peer messages into the session | the UI mod's `prompt.submit`, or hooks | `GET /poll` for notices, `POST /delivered` to mark them seen |
| human-only buttons | the UI mod band | `POST /human/*` with the token from the claim |

The socket path is `~/.quietsync/run/<first 12 chars of the session id>.sock` (a named pipe on Windows). `packages/cli/assets/hook.sh` is a working example of a thin hook client.

## Security requirements

An adapter is security-sensitive code. It won't be merged unless:

1. Every tool call goes through `/hook/pre-tool-use` before it runs, and `ask` becomes a confirm the model can't answer. If the agent has no such hook, the adapter isn't possible yet; say so in the issue.
2. `deny` really stops the call.
3. A typed human prompt is distinguishable from injected or automatic turns. If the agent can't tell, treat nothing as human and leave taint clearing to the band or a terminal command.
4. The human-control token is claimed through a channel the agent's own shell can't reach, or before the agent runs any tool (the bridge enforces the second).
5. Peer notices go into the session as the text the bridge produced, unmodified. Don't summarise or reformat them; the fence markers matter.
6. Tests: a recorded run in `docs/adapters/<agent>.md` showing link, a forced dialog, a blocked secret and a tainted-turn dialog.

## Agents we know about

| agent | tool gate | prompt source | push into a session | notes |
|---|---|---|---|---|
| Claude Code | `PreToolUse` hooks, plugin mods | `source` on `UserPromptSubmit` | mods `$.prompt.submit`, channels | shipped |
| Codex CLI | `PreToolUse` hooks; `ask` currently unsupported | `UserPromptSubmit` has no typed-versus-injected source field | needs adapter tests | native adapter pending; never copy Claude's ask response |
| Gemini CLI | `BeforeTool`, allow/deny | needs adapter tests | needs adapter tests | native adapter pending |
| opencode | version-specific plugin hooks | needs adapter tests | needs adapter tests | native adapter pending; test the installed 1.x API separately from 2.x |

Rows marked UNVERIFIED need someone to read that agent's current extension docs and fill them in. That's a good first contribution.
