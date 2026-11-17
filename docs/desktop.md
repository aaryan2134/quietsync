# Claude Desktop

PMs, managers and designers often use Claude Desktop's chat rather than Claude Code. QuietSync works there for messages that wait, with one difference: Claude Desktop chat has no hooks, so QuietSync can't put up its own dialog or gate the session. Instead, every send that would ask you opens an approval page in your browser.

```sh
quietsync setup --name dana --relay wss://… --no-plugins   # once, if this machine isn't set up yet
quietsync desktop install                                  # adds QuietSync to Claude Desktop's MCP servers
```

Restart Claude Desktop. `quietsync desktop install --print` shows the entry without writing anything, and `quietsync desktop remove` takes it out. Your old config is kept as `claude_desktop_config.json.bak`.

## What works there

| | Claude Code (CLI, desktop Code tab, VS Code, JetBrains) | Claude Desktop chat |
|---|---|---|
| messages that wait, answers, records | yes | yes |
| live links, files | yes | no: they need hooks to gate the session |
| approving a send | dialog in the session | page in your browser, opened by QuietSync |
| what's waiting when you open it | session start, band | listed in the instructions Claude gets at startup; Claude checks `quietsync_messages` |
| new message while it's open | band and notification | system notification |
| gate on Claude's other tools after reading someone's text | yes, peer privilege | no: Desktop doesn't let a plugin do that |

## The approval page

- **Where it runs:** QuietSync serves it on `127.0.0.1` at a random port, under a random path that only your browser is given. Claude never sees the address and can't click it.
- **What it shows:** the same text a dialog would: who it goes to, the scanner's findings, and the exact message, with Approve and Decline.
- **Other sites:** requests with the wrong host, origin or path get nothing.
- **If you take longer than two minutes:** the tool tells Claude it's still waiting. Once you've approved, Claude calls it again.
- **Your modes still apply:** a send your mode lets through (`auto` and it passes the checks) goes without a page.

## Be careful with

Reading someone's message puts their words in the conversation, and Desktop can't restrict what Claude does next. Don't run other powerful connectors (file system, shell, email) in the same conversation where you read people's messages. For that, use Claude Code, where QuietSync gates the session.
