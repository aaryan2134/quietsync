# RFCs

Changes that are hard to undo get written down and agreed on before they get built.

## When you need one

- **protocol:** anything on the wire (envelopes, frames, message types, relay API, team records) and any protocol version change
- **security model:** adding, removing or weakening a control or guarantee in [docs/security.md](../docs/security.md)
- **public API:** CLI commands and flags, `quietsync_*` MCP tool names and schemas, the hook and control socket contracts, `@quietsync/core` exports
- **new agent adapters** in `plugins/<agent>`

You don't need one for bug fixes, refactors, tests, docs, UI polish, or changes that only tighten existing rules (a new secret format, a new injection pattern). If you're not sure, ask in an issue or discussion first.

Unfixed vulnerabilities go through [SECURITY.md](../SECURITY.md). Write the RFC after disclosure.

## Lifecycle

1. **Draft.** Copy `0000-template.md` to `rfcs/0000-short-name.md`, fill it in, and open a draft PR. Talking the idea over in an issue first is optional but saves time.
2. **Discussion.** Comments happen on the PR. The author updates the document as things settle.
3. **Final comment period.** When a maintainer thinks it's ready, they propose accept or reject, label the PR `rfc: fcp`, and announce it. The FCP lasts 14 days. A new, substantial objection restarts it.
4. **Decision.** After the FCP, maintainers accept or reject (lead maintainer breaks ties). Either way the RFC is numbered and merged with its status and a short reason, so the decision stays easy to find.
5. **Implementation** happens in separate PRs that link the RFC. Typos and small clarifications to an accepted RFC are fine as normal PRs. Changing the design needs a new RFC that supersedes the old one.

## Numbering

The RFC number is the number of the PR that proposed it, zero-padded to four digits. On acceptance or rejection the file is renamed to `NNNN-short-name.md` and the title updated to match.

## Statuses

`Draft`, `FCP`, `Accepted`, `Rejected`, `Implemented`, `Superseded by NNNN`.
