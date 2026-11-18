# Releasing

## Before the first public push

- [x] Repository links point to `aaryan2134/quietsync`, including the CLI's marketplace fallback and the shipped bundle.
- [x] Maintainer and CODEOWNERS entries use `@aaryan2134`; security and conduct reports use `aaryan2134@gmail.com`.
- [ ] Require passing CI on `main` and verify branch protection after the repository is public. Keep private vulnerability reporting enabled and use Discussions for project questions.
- [x] Confirm rights to publish the repository and record the maintainer's declaration in [LEGAL.md](../LEGAL.md).
- [x] Check tracked text and media for personal data; the published demos use synthetic identities and sample paths.
- [x] Complete and record the independent bootstrap review, including reviewer, scope, findings and limitations ([security-review-2026-11-18.md](security-review-2026-11-18.md)).

## Every release

1. Update the version in `packages/cli/src/version.ts`, `packages/*/package.json` and `plugins/*/.claude-plugin/plugin.json`, and move the CHANGELOG section under the new version.
2. `bun install && bun run typecheck && bun run build && bun test && bun audit && gitleaks detect --no-git --source .`
   Also run `node --test scripts/test/*.test.mjs`. Record [client validation](client-validation.md) separately from the historical Claude test report.
3. `bun run release` builds `release/<version>/`: the plugin bundle `quietsync-<version>.tar.gz`, standalone binaries for macOS, Linux and experimental Windows support, `LICENSE`, `NOTICE`, `LEGAL.md`, `THIRD_PARTY_NOTICES.md` and `SHA256SUMS`. That folder is git-ignored.
4. Commit (including `plugins/claude-code/dist`, which Claude Code installs from), tag `v<version>`, push. The release workflow checks the tag matches the version and the committed plugin matches a fresh build, runs the tests, runs `bun run release`, attaches the bundle, binaries and checksums with build provenance to a draft release, and pushes the relay image to GHCR.
5. Check the draft release, then publish it.

During the private-repository trial, CI builds and health-checks the relay image without publishing it. CodeQL is skipped unless the private repository has the required GitHub Code Security entitlement and `QUIETSYNC_PRIVATE_CODEQL` is set to `true`; public repositories run it normally. Release provenance and the GHCR relay image are generated only by a tag workflow that starts while the repository is public. Making the repository public later cannot retrofit either artifact onto an earlier private tag run, so do not move or rebuild that tag: bump the prerelease version and cut a new tag after the visibility change. All workflow action references are pinned to upstream commit SHAs and are covered by Dependabot.

The standalone macOS binaries are ad-hoc signed only. People who download them get a Gatekeeper warning; `xattr -d com.apple.quarantine <file>` clears it. Signing and notarizing with a Developer ID is on the roadmap.
