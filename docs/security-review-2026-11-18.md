# Independent pre-public security review — 2026-11-18

## Review record

| field | value |
|---|---|
| reviewer | OpenAI Codex coding agent |
| commissioned and accepted by | Aaryan Arora, lead maintainer |
| implementation baseline | commit `134be878522fbe94ae1a90b0f62400473cae2ecf` (`v0.4.0-rc.3`) |
| remediation target | `v0.4.0-rc.4` |
| independence | the implementation was prepared through a Claude-assisted development process; this review used a separate OpenAI Codex agent and a fresh source review |
| review type | manual source review, threat-model trace, targeted regression test and release-compliance review |

The maintainer accepts this record as the independent bootstrap review required by [GOVERNANCE.md](../GOVERNANCE.md). It does **not** count as an external human audit, penetration test, formal cryptographic review or the two-person approval required when independent project reviewers are available.

## Scope

The review traced the security claims in [AUDIT.md](AUDIT.md), with emphasis on:

- envelope signatures, recipient binding, authenticated encryption, replay handling, ephemeral link keys and ratchets;
- link acceptance, exact-argument approval tickets, missing-hook behavior and peer-turn privilege;
- inbound framing and sanitization, outbound DLP, file inspection and quarantine;
- team cards, invite capabilities, memberships, admissions, revocations and relay directory authorization;
- relay authentication, mailbox routing, acknowledgements, rate and queue limits;
- key storage, local state permissions, audit and journal handling; and
- release permissions, provenance conditions, third-party notices and public documentation claims.

The review did not test a production deployment, perform network fuzzing, formally verify the cryptography, inspect upstream dependency source in full, or run the Windows UI and hook path.

## Findings

| id | severity | finding and impact | resolution |
|---|---|---|---|
| QS-2026-001 | low | `resolveTeamState` matched an admission to a signing key and handle but not to the invite capability recorded in that admission. An already admitted key could replace its membership with a newer membership under another valid capability and retain admission without the administrator admitting that exact membership. This did not admit a different signing key or bypass revocation, but it weakened the intended membership-to-admission binding. | Fixed by requiring `Admission.inviteId` to match `Membership.cap.inviteId`; added a regression test that keeps a replacement membership pending until separately admitted. |
| QS-2026-002 | informational | The test report called four earlier AI-agent review rounds “independent,” while other documentation correctly said no outside review had occurred. | Reworded them as internal adversarial rounds and separated this review from an external human audit. |
| QS-2026-003 | informational | Standalone binary release assets and the relay image did not carry third-party notices with the distributed object code; the notices existed only inside the plugin bundle. | The release folder now includes `LICENSE`, `NOTICE`, `LEGAL.md` and `THIRD_PARTY_NOTICES.md` as separate assets, and the bundle and relay image carry the same files. |

No critical, high or medium severity issue was identified in the reviewed scope. That is a result of this bounded review, not a claim that QuietSync is vulnerability-free.

## Validation

The targeted team regression passed. The final candidate also passed typecheck, a clean build, all 176 Bun tests, all 8 Node smoke tests, a 119-package dependency audit, a 20.78 MB secret scan, checksum verification for every release artifact, the native binary version check and a fresh relay-container health check. Details are recorded in [test-report.md](test-report.md); GitHub Actions and release provenance remain required on the public tag.

## Open review gaps

- No independent human security engineer has audited QuietSync.
- Windows remains experimental and untested for the band, hook and named-pipe paths.
- The same-user process boundary, scanner limitations, first-message and offline-message forward-secrecy gaps, and hostile-relay availability limits remain as documented in [security.md](security.md#known-limits).
- Public build provenance and the GHCR relay image require a new tag event after the repository becomes public; they cannot be added retroactively to the private `v0.4.0-rc.3` build.
