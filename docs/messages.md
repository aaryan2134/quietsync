# Messages that wait

Links are for two sessions working together right now. Messages are for everything else: your Claude needs an answer from someone who isn't in a session with you (your manager, a PM, a designer, someone on another team), so it asks, carries on, and picks the answer up when it comes.

## How it goes

1. Your Claude calls `quietsync_message(to, subject, text)`. You see the exact text in a dialog and approve it, same as a link send, unless your mode for that person is `auto` and it passes the checks ([levels](levels.md)). Secrets are redacted or blocked first.
2. If they're offline, the relay keeps it (sealed, it can't read it) for up to 7 days.
3. When their Claude Code is open, their QuietSync stores it and sends back **delivered**. Their band shows the question with **Answer with Claude**, **Later** and **Dismiss**, and a new session tells them what's waiting when it starts. Nothing reaches their agent yet, unless their mode for you lets it through on its own (an FYI in `review`, a question in `auto`).
4. They press **Answer with Claude**: their agent reads the question (at peer privilege, fenced as someone else's text), drafts an answer from their repo and what they tell it, and they approve the exact text. Or they answer from a terminal: `quietsync reply <id> "yes, drop it"`. You get **seen** when they look, if their profile sends read receipts.
5. The answer comes back to the project you asked from, even if that session ended. Your band shows it with **Continue**. Pressing it hands the answer to your Claude, which carries on with the work it was blocked on.

```
you                     relay                    priya
quietsync_message ─────▶ queued (7 days) ───────▶ stored ─▶ band: "alice asks…"
   ◀──────────────────── delivered ◀───────────────┘
   ◀──────────────────── seen ◀──────────────────── Answer with Claude / quietsync reply
   ◀──────────────────── answer ◀───────────────── she approves the text
band: "priya answered" [Continue] ─▶ your Claude carries on
```

## States

| your question | meaning |
|---|---|
| queued | the relay is holding it; they haven't been online since |
| sent | handed to one of their open sessions |
| delivered | their QuietSync stored it |
| seen | their human looked at it (only if their profile sends receipts) |
| answered | the answer is here |
| declined | they dismissed it (only if their profile sends receipts) |
| expired | nobody picked it up within 7 days |

`quietsync messages` lists open threads, `--all` everything, `quietsync messages show <id>` one thread with its answer.

## FYIs

`needs_reply: false` (or `quietsync ask --fyi`) sends a message that needs no answer: "the v2 schema is final". It shows on their band with **Got it**.

## The contact book

Your contacts and teammates are the people you can message. Tell your Claude who handles what:

```sh
quietsync contact priya --role "eng manager" --note "scope, priorities, hiring"
quietsync contact dana --role design --note "UI copy, empty states, the design system"
```

`quietsync_status` shows these to your Claude, so "ask whoever decides scope" goes to Priya. Only you can set them, at your own terminal.

## Keeping a written record

QuietSync doesn't replace the record your team keeps. It can post each thread there:

```sh
quietsync records add eng-decisions slack --url https://hooks.slack.com/services/…
quietsync records add jira jira --site https://acme.atlassian.net --email you@acme.com --token env:JIRA_API_TOKEN --auto
quietsync records add mail email --to team-leads@acme.com
quietsync records add notes file --dir ~/quietsync-records
quietsync records test eng-decisions
```

| type | what happens |
|---|---|
| slack | posts to a Slack incoming webhook |
| jira | comments on the thread's ticket (`ticket: PAY-123` on the question) |
| email | opens a draft in your mail app; you send it |
| webhook | POSTs JSON to any https URL (Teams, Discord, Zapier, n8n) |
| file | writes a markdown file, owner-only |

Post one thread with `quietsync records post <id> <name>`, or let your Claude do it with `quietsync_record` (you approve the exact text). Destinations added with `--auto` get every answered question, posted once even with several sessions open.

Secrets in the thread block the post. Slack mentions (`<!channel>`) and Jira markup in someone's text are neutralised. URLs must be https, redirects are refused. Webhook URLs and tokens live in `~/.quietsync/records.json`, which the agent can't read; `env:NAME` keeps them in an environment variable instead.

## Safety

- Only your contacts and teammates can message you. Strangers' messages are dropped, and so are blocked contacts'.
- A message reaches your agent only when you press **Answer with Claude** or **Show Claude**, your agent opens it with `quietsync_messages`, or your mode for the sender lets that kind through on its own ([levels](levels.md)). Every way, the turn runs at peer privilege, like a link message: reading files works, anything else asks you.
- **Continue** runs the answer as your turn only when the whole answer fit on the band (up to 1,200 characters and 16 lines) and passed the injection checks, so you've read everything your agent is about to get. A longer or flagged answer runs at peer privilege instead; read it in full with `quietsync messages show <id>`.
- Once someone's message has been in a session, that session stays gated as if a link with them were open: sending data out and reading sensitive files ask you, and for outside contacts (strict isolation) anything beyond reading asks. The band says so, with a **Done with it** button; `/links done` and `/clear` end it too, and it survives a resume.
- Automatic records only post threads you started, with your own ticket, after you press Continue. Someone else's question, and the ticket they picked, only go to a record when you post it yourself; the dialog says when the ticket is theirs.
- `quietsync messages`, `ask`, `reply`, `dismiss`, `contact` and `records` need a person at their own terminal: they refuse to run anywhere under Claude Code, and sending asks you to type `send`. Commands that wrap something in a fake terminal (`script`, `unbuffer`, `pty.spawn`) ask you first.
- An answer only counts if it answers a question you sent to that same person, once.
- At most 20 unread messages per person and 200 in total; more are dropped. Senders are rate limited per minute.
- Messages stay in `~/.quietsync/notes.json` (owner-only, off limits to the agent) until they're done, then are pruned after 30 days or your profile's audit period, whichever is longer.
- Messages that wait are sealed to the person's long-term key. That means no forward secrecy for them yet, unlike links: someone who records the traffic and later steals that person's key could read them. See [security.md](security.md#known-limits).

## Profiles

| switch | default | company | friends | startup |
|---|---|---|---|---|
| `messages` | on | on | on | on |
| `records` | on | on | on | on |
| `receipts` (seen, declined) | on | on | off | off |

Delivered receipts always go: without them a queued message can't be trusted. A team admin or IT can turn `messages` or `records` off (`quietsync team profile payments company messages=false`).
