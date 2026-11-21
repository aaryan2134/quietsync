# Levels: modes and rules

Some messages should just go through: "the v2 schema is final", "staging is on 8443 now". Some need both people to look first: a request to change code, anything to someone outside the company. QuietSync decides with a **mode** per person or team, like Claude Code's permission modes, plus **rules** for single kinds of message, and an admin can cap how far either goes.

## Modes

| mode | what you send | what arrives | default for |
|---|---|---|---|
| `ask` | you approve each one | waits on the band until you open it | outside contacts |
| `review` | you approve each one | FYIs and answers go straight to your agent; questions and requests wait for you | teammates |
| `auto` | goes without a dialog when it passes the checks below | FYIs and answers go to your agent, and it answers questions it can answer without you; requests wait | nobody, you opt in |
| `trusted` | goes without a dialog when it passes the checks | everything goes to your agent, requests too, and link requests are accepted | your own devices |

```sh
quietsync mode priya auto           # one person
quietsync mode team:payments auto   # everyone in a team
quietsync mode team review          # all teammates
quietsync mode external ask         # everyone outside your teams
quietsync contacts                  # shows each person's mode, and the cap if there is one
```

Raising a mode asks you to type a confirmation at your own terminal. Your agent can't change modes: the command refuses to run under an agent, and the files are off limits to it.

### The checks before anything goes on its own

In `auto` and `trusted`, a message, an answer or a live-link send still opens the usual dialog when any of these is true:

- the scanner found something: a secret it redacted, a flagged term, a custom rule
- words from anyone else are in this turn, even if the person you're writing to spoke last (so carol's message can't make your agent write to priya on its own)
- your agent read a sensitive file (`.env`, keys, shell history, its own settings) since you last typed
- it carries more than 40 lines of code, or is longer than 4,000 characters
- this person already got your auto-send limit's worth of automatic sends in the last hour (10 by default, 5 on the company profile); live links also stop after that many sends in a row without you

The dialog says which check held it.

### What arriving on its own means

- An FYI or answer that your mode lets through is handed to your agent at peer privilege, the same as a link message: reading files works, anything else asks you, and it's logged. The session stays gated until you press "Done with it" or `/clear`.
- An answer goes to a session in the project that asked. If none is open, it waits and is handed over when you open one there.
- Anything else goes to one session, whichever claims it first. It doesn't show on the band as waiting, and `quietsync messages` lists it as "with your agent".
- In `auto`, your agent answers a question only if it can without a decision from you. Otherwise it tells you, and the question waits for you.
- Delivered receipts go either way. "Seen" still means a person looked.

## Rules

Rules adjust one kind of message for one person or group, like Claude Code's allow, ask and deny rules. deny beats ask, and ask beats allow.

```sh
quietsync rules allow "fyi(team:payments)"   # FYIs with the payments team flow both ways
quietsync rules allow "out:answer(priya)"    # your answers to priya go without a dialog
quietsync rules ask "request(*)"             # requests always wait for a person
quietsync rules deny "send(external)"        # your agent never messages outside contacts
quietsync rules list
quietsync rules remove "fyi(team:payments)"
```

- **kind:** `fyi`, `ask` (questions), `answer`, `request`, `send` (anything you send), `receive` (anything that arrives) or `*`.
- **who:** a contact name, `team:<name>`, `team`, `external`, `self` or `*`.
- **direction:** prefix `in:` or `out:` to pick one.

An allow rule can't take a kind past the cap. If your admin caps outside contacts at `ask`, `allow "send(external)"` still opens a dialog.

## Caps

The highest mode per relationship comes from your profile, your team's profile and the managed policy, and the lowest one wins:

| profile | teammates | outside contacts | your devices |
|---|---|---|---|
| default, friends | up to trusted | up to trusted | trusted |
| company | up to auto | ask (and outside contacts are off anyway) | auto, since automatic links are off |
| startup | up to auto | ask | auto |

An admin sets caps and rules in the managed policy:

```json
{
  "profile": "company",
  "modes": { "team": "auto", "external": "ask" },
  "rules": { "ask": ["request(*)"], "deny": ["send(external)"] }
}
```

Teams and an env-supplied policy can add `ask` and `deny` rules. Only you and the managed policy can add `allow`.

## Where it's decided

- `packages/core/src/levels.ts`: modes, rules, flows
- `packages/core/src/rules.ts`: `resolvePolicy`, `clamp`, `withFlow`
- `packages/core/src/policies.ts`: caps and rules from every source
- `packages/core/src/policy.ts`: `holdAuto`, `message`, `reply` and `send`
- `packages/core/src/node.ts`: `onNote` and `applyNote`
