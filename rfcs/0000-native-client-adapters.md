# Draft: native client adapters

Status: Draft. This is a design and verification backlog, not an implemented security claim.

## Problem

QuietSync's core is agent-independent, but the current full tool gate and live UI rely on Claude Code. The existing messages-only MCP surface can be configured in other clients without granting QuietSync control over their shell or file tools.

## Proposed sequence

1. Reproduce a model-driven messages-only question/reply between different clients and two real identities. Keep the browser approval path and state its host-tool limitations.
2. Implement a Codex-specific hook adapter after recording its installed hook semantics. Codex currently does not implement Claude's `PreToolUse` ask response. A requested human approval must be enforced through a tested alternative or the tool must be denied.
3. Add a Gemini adapter using its allow/deny hooks and a separately tested human approval path.
4. Treat installed OpenCode 1.x and its newer plugin API as distinct compatibility targets. Verify runtime hook execution rather than relying on published types alone.

## Acceptance evidence for each full adapter

- Every relevant host tool reaches the gate, including shell, edits, MCP and nested tool paths.
- A denial prevents execution; an approval shows the exact action to a human. A model cannot produce that approval.
- Missing, failing and timed-out gate paths cannot release peer content into an unprotected session.
- Prompt provenance cannot mistake an injected or automatic continuation for typed human input.
- Peer taint survives link closure, resume and compaction as required by the existing threat model.
- Agent configuration, keys and control capabilities stay protected; replies use the existing scanner and framing.
- Automated regressions and a recorded live trial establish the behavior on the exact supported client version.

Until those conditions are met, keep the configuration recipes labeled experimental messages-only. The wire protocol and Claude integration remain unchanged by this RFC.
