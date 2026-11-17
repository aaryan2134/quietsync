# Client validation, 17–18 November 2026

This report adds fresh checks to the existing [Claude test report](test-report.md). It does not replace that report. The tested source is `fcbb508d1949035dd1b2196da85503468804fd6a` at version `0.4.0-rc.3`, on macOS 15.7.3 arm64 with Node 26.4.0 and Bun 1.4.4.

## Client results

| Surface | Version | Fresh evidence | Still unverified |
| --- | --- | --- | --- |
| OpenCode | 1.14.50 | The real `opencode mcp list --pure` command connected to the shipped messages-only bridge using a disposable configuration | Hosted-model tool call, approval and peer-message round trip; native hook adapter |
| Gemini CLI | 0.42.0 | The real `gemini mcp list` command connected to the shipped messages-only bridge using a disposable configuration | Hosted-model tool call, approval and peer-message round trip; native hook adapter |
| Codex CLI | 0.147.0 | The real client connected and its model selected `quietsync_status`; the host then cancelled the MCP approval, so no status result was returned | Approved tool result, approval-page send and peer-message round trip; native hook adapter |
| Direct MCP stdio | Node 26.4.0 | Initialize and tool discovery; the messages-only surface exposes eight tools before setup; live-link and file calls are refused; the hooked surface refuses a gated send without a hook ticket | Relay-backed identity and browser-approval trial through an installed host |

`scripts/probe-clients.mjs` reports discovery, model-to-tool invocation and peer-message round trips separately. Its fresh result was `connected: true` for all three clients, `modelToolCall: true` only for Codex, and `peerMessageRoundTrip: false` for all three. A selected tool that the host cancels is not a successful tool result.

The probe uses temporary client settings and an empty QuietSync directory. It preserves installed client settings and the user's identity. OpenCode runs without external plugins. Gemini uses a dummy API key only for MCP discovery and makes no model call. No client credential is copied into the fixture or CI.

## Repository and runtime checks

Local validation passed:

- frozen Bun installation, TypeScript typecheck and a fresh reproducible build
- all 175 Bun tests and all eight dependency-free Node smoke checks
- repository metadata, Markdown-target and pinned-action checks
- `bun audit` with no vulnerabilities after updating the lockfile to `@hono/node-server` 2.1.6 and Hono 4.13.16
- Gitleaks against committed history and the working tree, with no leaks found
- the relay image from a clean private clone, including `/healthz` after the expected startup retry
- the bridge regression suite inside a Linux Node 22 and Bun 1.4.4 container

GitHub Actions run [44179100270](https://github.com/aaryan2134/quietsync/actions/runs/44179100270) passed the full macOS and Ubuntu suites, dependency audit and secret scan, clean-checkout relay container, and informational Windows unit job. The macOS run used Node 22 and verified that an oversized control-socket path fails closed consistently across supported Node versions. Private CodeQL is skipped because the repository does not have the required GitHub Code Security entitlement; that is not a passed CodeQL analysis.

## Remaining live trial

Discovery and automated protocol tests do not replace the trial in [client-trial.md](client-trial.md). Two synthetic identities still need a normal human to decline a send, approve a question and reply, reconnect an offline recipient, and inspect dummy-secret redaction or blocking. Then two different people should repeat the exchange on separate machines. No real credential should be used.

The experimental clients remain messages-only integrations. They do not gain QuietSync's Claude Code hook gate, live links, band, file transfer or peer-turn restrictions. Full native adapters remain pending under [the adapter RFC](../rfcs/0000-native-client-adapters.md).
