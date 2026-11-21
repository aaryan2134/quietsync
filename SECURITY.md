# Security policy

QuietSync puts text written by someone else's agent into your agent's context, so we take security reports seriously and handle them first. For what the system defends against and how, read [docs/security.md](docs/security.md).

## Supported versions

Only the latest stable release receives security fixes. Upgrade to it before reporting if you can.

| version | supported |
|---|---|
| latest stable release | yes |
| anything older | no |

The wire protocol (v1) is versioned separately. If a fix needs a protocol change, we ship it as a new protocol version once the issue is public.

## Reporting a vulnerability

Please don't open a public issue, PR or discussion for a security problem.

1. **GitHub private vulnerability reporting (preferred).** Go to the repo's Security tab and click "Report a vulnerability", or open https://github.com/aaryan2134/quietsync/security/advisories/new.
2. **Email** `aaryan2134@gmail.com` if you can't use GitHub.

Include what you can of:

- version or commit, OS, and agent CLI version
- which part is affected (core, relay, CLI, bridge, hooks, plugin)
- steps to reproduce or a proof of concept
- what an attacker gets out of it
- for injection reports, the exact payload and what the model and the human saw

Use test identities and dummy data. Don't send us real secrets, keys or other people's messages. Only test against your own sessions and relays you run yourself.

## Scope

In scope is anything that breaks a promise in the "What we protect" section of docs/security.md:

- **consent bypass:** a link, accept, send or policy change happening without a human choosing it, for example getting past the send dialog, the bridge ticket check or the taint gate
- **secret leakage:** files, secrets or environment reaching a peer without approval, the outbound scanner missing a format it's meant to block, or keys and audit logs readable by other local users
- **injection reaching the model unfenced:** peer text escaping its fence, landing in context outside it, or getting characters and tags past the sanitizer that it's meant to strip
- **crypto and protocol flaws:** reading, forging, altering or replaying messages, impersonating a peer, reusing an invite, or forging team membership or revocation
- **relay auth:** connecting as a key you don't hold, writing another key's team record, or reading another key's queue

Out of scope:

- anything listed under "Known limits" in docs/security.md (Read during peer turns, the pattern-based shell guard outside a tainted turn, traffic analysis and denial of service by a hostile relay, device linking copying keys, org plugins skipping mod hooks, the band as trust anchor). A way around the control that's supposed to cover one of these is in scope.
- social engineering of the human, like talking someone into approving a send, accepting a link or turning on auto-send
- peer text fooling the model, as long as the human-facing gates still hold
- bugs in Claude Code or other agent CLIs themselves (report those to the vendor), unless QuietSync makes them reachable
- attacks that need root or an already compromised local account
- scanner output with no demonstrated impact

If you're not sure, report it anyway.

## What to expect

| step | target |
|---|---|
| acknowledge your report | 3 business days |
| triage: confirm, set severity | 7 days |
| fix or mitigation plan, high and critical severity | 30 days |
| fix, lower severity | a following regular release |

These are targets for a small team. If we're going to miss one, we'll tell you.

## Disclosure

We follow coordinated disclosure with a 90 day default from the day you report. When a fix ships we publish a GitHub security advisory and request a CVE where it fits. We can agree on a different date with you, for example when a fix needs an agent CLI vendor to ship something too. If a bug is being exploited in the wild we may publish sooner, and we'll tell you first.

## Credit

We credit reporters by name or handle in the advisory and the release notes. Tell us if you'd like to stay anonymous. There's no bug bounty right now.
