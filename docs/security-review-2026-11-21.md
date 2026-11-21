# Independent 1.0 security follow-up — 2026-11-21

## Review record

| field | value |
|---|---|
| reviewer | OpenAI Codex coding agent |
| commissioned and accepted by | Aaryan Arora, lead maintainer |
| implementation baseline | commit `d5c8fc958e1f3428e2ba5576d724996c9a1d01aa` (`v0.4.0-rc.4`) plus the maintainer-supplied 1.0 candidate changes |
| remediation target | `v1.0.0` |
| independence | the candidate changes were produced through a Claude-assisted process; this review used a separate OpenAI Codex agent, inspected the patch and source, and added its own remediations and tests |
| review type | manual source review, threat-model trace, CodeQL triage, targeted regression testing and release-compliance review |

The maintainer accepts this as the independent AI bootstrap review required by [GOVERNANCE.md](../GOVERNANCE.md). It is **not** an external human audit, penetration test, formal cryptographic review or two-person project approval.

## Scope

The review covered the candidate diff and the affected claims in [AUDIT.md](AUDIT.md), with emphasis on:

- peer-turn taint across several peers, search tools, sensitive-read tracking and automatic-send caps;
- Claude Code hook and UI-band prompt provenance, fail-closed delivery and exact QuietSync MCP tool matching;
- outbound DLP parsing, automatic records and organization-status output identified by CodeQL;
- relay authentication, queueing, acknowledgements, rate limits and SQLite resource growth;
- the unchanged envelope and link cryptography in `crypto.ts`, `envelope.ts` and the relevant `node.ts` flows; and
- versioning, legal notices, generated bundles, release assets, provenance and GHCR publication.

The review did not test a production deployment, perform network fuzzing, formally verify the cryptography, inspect upstream dependency source in full, or run the Windows, Linux desktop or IDE integration paths.

## Findings

| id | severity | finding and impact | resolution |
|---|---|---|---|
| QS-2026-004 | medium | Claude Code can label a prompt submitted by the UI band as `source: "user"`. An automatic peer wake-up could therefore be mistaken for a typed human prompt and clear peer-turn state after the turn. | Automatic band prompts and explicit human Continue prompts now use distinct trusted markers; bridge-origin prompt events no longer count as composer input. Regression coverage exercises peer, unsourced and Continue paths. |
| QS-2026-005 | medium | Grep and Glob can return protected-file lines reached indirectly even when their root and pattern look safe. During a peer-driven turn that could bring sensitive text into context without a dialog. | Every search during a peer-driven turn now asks. Any search while peer text is involved also marks the session as having read potentially sensitive content, holding later automatic sends. |
| QS-2026-006 | medium | Relay acknowledgement frames bypass the normal request rate limit, and acknowledgements for arbitrary nonexistent IDs were inserted into SQLite until hourly pruning. An authenticated client could grow relay state cheaply. | The relay now accepts acknowledgements only for an envelope queued for that key or currently in flight. A 500-ID bogus acknowledgement regression leaves the table empty. |
| QS-2026-007 | low | Live-link auto sends used only the in-a-row cap, while queued messages and answers used an hourly cap. Reopening links could reset the effective live-send limit. | All automatic send types now share a private, persistent, per-peer hourly ledger, in addition to the in-a-row cap. |
| QS-2026-008 | low | CodeQL reported polynomial regular expressions in base64-padding removal and email validation, and clear-text logging of organization metadata. Generated bundles duplicated source alerts and included an upstream dynamic-function warning. | Replaced the two parsing expressions with bounded logic, made organization output generic, and configured CodeQL to analyze source rather than the committed generated bundle. |

The candidate also fixed multi-peer taint identity tracking, overly broad QuietSync MCP name matching, env-file coverage, scanner gaps, automatic-record warnings and collision-label length. This review traced those changes to tests and did not identify a remaining critical or high-severity issue in the reviewed scope.

## Cryptography and relay conclusion

No cryptographic primitive or wire-format change was introduced for 1.0. The review rechecked recipient-bound signed envelopes, X25519/HKDF sealed boxes, XChaCha20-Poly1305 nonces and AAD, per-link ephemeral keys, directional link keys, the message ratchet, timestamp limits and key wiping calls. No new defect was identified in that bounded review. This is not a formal cryptographic audit.

The relay remains untrusted for confidentiality and integrity of plaintext and partly trusted for availability. The acknowledgement resource issue above was fixed; hostile-relay withholding, traffic analysis and denial of service remain documented limits.

## Validation

The candidate passed repository checks, typecheck, a clean build, all 187 Bun tests, all 8 Node smoke tests, dependency and secret scans, release checksums, native version verification and a fresh relay-container health check. Details are recorded in [test-report.md](test-report.md). GitHub CI and CodeQL must pass with zero open alerts, and the GHCR package must grant this repository Actions write access before the stable release is published.

## Open review gaps

- No independent human security engineer has audited QuietSync.
- Windows remains experimental and untested; Linux desktop and IDE integrations remain untested.
- The same-user process boundary, scanner limitations, first-message and offline-message forward-secrecy gaps, and hostile-relay availability limits remain as documented in [security.md](security.md#known-limits).
- AI review does not provide organizational independence, professional certification or a warranty of security.
