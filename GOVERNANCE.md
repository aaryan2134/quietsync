# Governance

QuietSync is a small project. This is the least process we need today, written so it can grow with the project. Everyone involved follows the [code of conduct](CODE_OF_CONDUCT.md).

## Roles

- **Users** run QuietSync. Bug reports, feature ideas and adapter requests are contributions too.
- **Contributors** open issues, PRs, reviews or RFCs. Commits carry a DCO sign-off (`git commit -s`).
- **Committers** can merge in one or more areas: `core`, `relay`, `cli`, `plugins`, `docs`, or a specific adapter. They review and merge PRs in their areas under the approval rules below.
- **Maintainers** can merge anywhere. They also cut releases, handle security reports, decide RFCs, and add committers and maintainers.
- **Lead maintainer** breaks ties when maintainers can't agree. This role exists while the project is small. Once there are three or more maintainers, they can retire it by majority vote and settle ties by vote instead.

Current people and areas are in [MAINTAINERS.md](MAINTAINERS.md).

### Private bootstrap stage

There is currently one maintainer. Private experimental branches can be prepared and tested by that maintainer; they do not count as independently reviewed. Before a public release, obtain independent review of changes to the security model and record the reviewer and scope. The multi-reviewer merge rules below become enforceable when enough independent reviewers are available. Until then, require CI on `main`, record validation and open review gaps explicitly, and do not describe solo work as satisfying a two-person security review.

The bootstrap review for `v0.4.0-rc.4` is recorded in [docs/security-review-2026-11-18.md](docs/security-review-2026-11-18.md). It was performed by an OpenAI Codex coding agent independently of the Claude-assisted implementation process. It is an AI review, not an external human audit or a two-person approval.

The follow-up review for `v1.0.0` is recorded in [docs/security-review-2026-11-21.md](docs/security-review-2026-11-21.md) under the same limitations.

## Becoming a committer

1. Make sustained, good quality contributions to an area over a few months. Reviews, triage and docs count as much as code.
2. A maintainer nominates you by opening a PR that adds you to MAINTAINERS.md.
3. Lazy consensus for 7 days. If no maintainer or committer in that area objects, it merges. An objection has to give a reason and moves the decision to the maintainers.

Maintainers are picked from committers the same way, except the PR needs approval from a majority of maintainers.

## How decisions get made

**Normal changes** (fixes, features inside the current design, refactors, docs, tests) use lazy consensus. A PR can merge once it has the approvals it needs and no open objections. That's one approval from a committer for the area, and the author can't approve their own PR.

**RFCs** are needed for:

- the protocol: wire format, envelopes, message types, relay API, protocol versions
- the security model: adding, removing or weakening a control or guarantee in [docs/security.md](docs/security.md)
- public API: CLI commands and flags, `quietsync_*` MCP tools, the hook and control socket contracts, `@quietsync/core` exports
- new agent adapters

See [rfcs/README.md](rfcs/README.md) for the process.

**When people disagree**, talk it out on the PR or RFC. If that stalls, maintainers decide by consensus, and the lead maintainer breaks a tie.

## Security-sensitive paths

These decide what reaches the model, what leaves the machine, and what needs a human:

- `packages/core/src/crypto.ts`
- `packages/core/src/envelope.ts`
- `packages/core/src/policy.ts`
- `packages/core/src/sanitize.ts`
- `packages/core/src/dlp.ts`
- `packages/core/src/node.ts`
- `packages/core/src/{rules,policies,guard,frame,team}.ts`
- `packages/cli/src/bridge.ts`
- `packages/cli/src/hook.ts`, `packages/cli/src/ipc.ts`, `packages/cli/assets/hook.sh`
- `plugins/claude-code/hooks/`
- `plugins/claude-code-ui/hooks/`

A PR touching any of them needs two approvals, at least one from a maintainer, and neither from the author, once enough independent reviewers are available; the private bootstrap stage above applies while there is only one maintainer. [CODEOWNERS](.github/CODEOWNERS) routes them to the current maintainer. If the change affects a guarantee, update docs/security.md in the same PR.

Fixes for unreported or embargoed vulnerabilities are reviewed privately per [SECURITY.md](SECURITY.md). The same two-approval rule applies, and any RFC is written after disclosure.

## Releases

- Packages (`quietsync`, `@quietsync/core`, `@quietsync/relay`, the plugins) follow semver.
- The protocol version (v1, in [docs/protocol.md](docs/protocol.md)) is separate from package versions and only changes through an accepted RFC.
- User-facing PRs add a changeset, or a line in CHANGELOG.md until changesets is set up. Release notes come from those.
- A maintainer cuts releases from `main` once CI is green, tags `vX.Y.Z`, and publishes the packages and the relay image.

## Stepping down

- Anyone can step down at any time by opening a PR that moves them to the emeritus list in MAINTAINERS.md.
- After 12 months with no reviews, commits or replies, maintainers will check in and may move someone to emeritus.
- Emeritus members keep the credit and lose merge, release and security access. Maintainers remove that access within a week. Coming back takes a maintainer nomination and 7 days of lazy consensus.

## Changing this document

Open a PR. Changes need approval from a majority of maintainers.
