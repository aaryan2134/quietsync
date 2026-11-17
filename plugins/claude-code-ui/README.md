# quietsync-ui (Claude Code mod)

The visible half of QuietSync. Installing it also installs the core `quietsync` plugin.

- a band above the prompt, tinted by who you're linked with: red for external, amber for teammates, blue for your own other machine
- link requests with the first message for you to read, and Accept, Decline and "Always accept from" buttons (`ctrl+x`, `tab`, then `a` / `d`)
- one row per link, with group, role, one-way and isolation notes; Close (`c`), Auto-send (`u`, behind a warning you confirm with `y`), and "Block secrets again" when you allowed them
- wakes an idle session when a peer message arrives, and raises a native notification for new requests
- `/links` shows what this session is linked with; `/links pause`, `/links resume` and `/links mode <role>` narrow this session

Uses the Claude Code mods API (early access, tested on 2.1.312, macOS). If your org's managed security plugin skips mod hooks, the approval gate still runs from the core plugin's command hooks. Windows isn't supported yet.
