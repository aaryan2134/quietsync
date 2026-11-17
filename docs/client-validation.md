# Client validation, 17 November 2026

This report adds fresh checks to the existing [Claude test report](test-report.md). It does not replace that report or rerun its 167-test suite. The source remains `0.4.0-rc.3`, with unreleased repository-preparation changes.

## Results

| Surface | Version | Fresh evidence | Still unverified |
| --- | --- | --- | --- |
| OpenCode | 1.14.50 | The real `opencode mcp list --pure` command connected to the shipped messages-only bridge using a disposable configuration | Hosted-model tool call; approval and peer-message round trip; native hook adapter |
| Gemini CLI | 0.42.0 | The real `gemini mcp list` command connected to the shipped messages-only bridge using a disposable configuration | Hosted-model tool call; approval and peer-message round trip; native hook adapter |
| Codex CLI | 0.147.0 | Installed and authenticated with ChatGPT; native probe attempted | Probe blocked before MCP startup by read-only Codex state and app-server `EPERM`; native hook adapter |
| Direct MCP stdio | Node 26.4.0 | Initialize and tool discovery; messages-only surface has eight tools before setup; live-link/file calls refused; hooked surface refuses a gated send without a hook ticket | Relay connectivity, identity setup, browser approvals and messages |

The eight dependency-free checks in `scripts/test/` pass. They cover configuration generation for all three clients and the shipped bridge checks above. A fresh identity is deliberately unconfigured, so its status call returns an error rather than claiming to be ready. Passing transport discovery does not establish successful communication between people.

## Scope of the native probes

`scripts/probe-clients.mjs` uses temporary client settings and a fresh, empty QuietSync directory. It preserves the user's installed client configuration and identity. OpenCode is launched without external plugins. Gemini's temporary fixture selects API-key mode with a **dummy key solely for MCP discovery**; no Google model call or authentication was tested, and no user's credentials were copied. Folder trust is disabled only inside that disposable Gemini configuration. Temporary files are removed afterwards.

The Codex probe uses an ephemeral read-only invocation with user configuration ignored. This execution environment prevents its state/app-server startup; the probe does not try to bypass that restriction. It must be rerun in a normal user terminal.

## Environment blockers reproduced

- Node cannot listen on either a short Unix socket in `/tmp` or loopback TCP: both return `EPERM`. The bridge's generic control-socket error suggests a shorter path, but a short-path preflight reproduces the permission failure here. The relay cannot run in this environment.
- npm registry access fails, so workspace dependencies cannot be freshly installed.
- OpenCode embeds Bun 1.3.13. Bun's documented `BUN_BE_BUN=1` mode can run it as a development runtime, but it rejects this project's version-2 lockfile. The project now pins the archive's tested Bun 1.4.4; the lockfile was kept intact.
- Docker's CLI is installed, but its configured Colima daemon socket is absent. The revised relay Dockerfile and container health check therefore await CI or a running local Docker daemon.

## Reproduce outside the restricted session

From a normal terminal in the checkout, with Node 22+ and Bun 1.4.4:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
bun test
node --test scripts/test/*.test.mjs
node scripts/probe-clients.mjs
bun audit
docker build --file packages/relay/Dockerfile --tag quietsync-relay:trial .
```

The probe's `connected` and `modelToolCall` fields describe different stages; `peerMessageRoundTrip` stays false because the probe does not send to another identity. A nonzero result means at least one native discovery check failed; preserve the reason rather than marking the client supported.

Then follow [the client trial](client-trial.md) with two synthetic identities: decline a send, approve a send, read and reply, reconnect an offline recipient, and verify a dummy-secret case. Record the result against the exact commit used. Those stages are pending for all three clients.

## Compatibility conclusion

OpenCode and Gemini CLI have verified native **MCP connection** results. They have experimental messages-only configuration recipes. Full native adapters, model-driven messaging, and per-host tool-gate guarantees remain unverified. Claude Code's previous validation remains historical evidence for its own integration, not evidence for these other hosts.
