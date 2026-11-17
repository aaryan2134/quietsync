# RFC 0000: Title

- Status: Draft
- Authors:
- PR:
- Protocol version: none / v1 / new version

## Summary

One paragraph. What changes, for whom.

## Motivation

What problem this solves, who has it, and why now. Real examples help.

## Design

Enough detail that someone else could build it. Wire formats, CLI and MCP changes, config, and a worked example.

## Security considerations

QuietSync assumes the peer may be compromised and the model may be fooled. Explain how that still holds.

- **Threat model delta:** what changes for each adversary in [docs/security.md](../docs/security.md) (relay operator, stranger, stolen invite holder, compromised peer, your own injected agent). New data on the wire, new things that reach the model, new things that can leave the machine.
- **Consent:** can anything here link, send, accept or relax a policy without a human choosing it?
- **What reaches the model:** is it sanitized and fenced?
- **Secrets:** can file contents, keys or environment end up in a send, a log or the relay?
- **Docs:** which parts of docs/security.md change, including "Known limits".

## Protocol and wire compatibility

- Does this change the wire format or relay behavior? Does it need a new protocol version?
- What happens when old and new clients, or clients and relays, talk to each other?
- Does stored state (`~/.quietsync` files, the relay database) need migrating?

## Alternatives

Other designs you considered and why you didn't pick them. Include doing nothing.

## Unresolved questions

What still needs answering before or during implementation.

## Rollout

Release order (relay first?), defaults and flags, docs to update, and how to back it out.
