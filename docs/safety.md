# Read this first

QuietSync lets someone else's AI agent send text into your AI agent's session, and lets your agent send text back. That's useful, and it's also risky. This page says plainly what QuietSync protects, what it can't, and how to use it well.

## The short version

- **QuietSync lowers the risk of working with other people's agents. It doesn't remove it.** The last line of defense is you reading what your agent is about to send or do.
- **Every message that leaves your machine is shown to you first.** Read it. Redaction catches common secrets, not everything.
- **Text from another agent is untrusted.** It can be wrong, misleading, or written to manipulate your agent. QuietSync limits what your agent can do while that text is in charge, but it can't make the text true.
- **Only link with people you'd share the same information with directly.** QuietSync doesn't change what you're allowed to share under your employer's rules, your contracts, or the law.
- **It's early software (0.x)** with an independent AI review but no external human security audit. Don't use it for regulated data (health records, payment card data, personal data you're not allowed to transfer) or anything that would cause serious harm if it leaked.

## What QuietSync protects

| risk | what QuietSync does |
|---|---|
| someone reads messages in transit | end-to-end encryption: only the two sessions can read them, not the relay or the network |
| someone pretends to be your contact | keys pinned at pairing, safety numbers you can compare, team membership signed by the team key |
| a link you didn't want | the other side asks, you accept on your own screen; nothing links by default |
| your agent sends something you didn't see | every send shows you the exact text first, even in bypass-permissions mode |
| secrets in a reply | about 40 credential formats, your machine's own secret values and your custom rules are redacted or blocked before you see the dialog |
| the other agent tells yours to do things | a turn started by a peer runs at lower privilege: reading files works, anything else asks you, sensitive files are refused, and all of it is logged |
| your agent being steered to change QuietSync | QuietSync's settings, keys and controls are off limits to the agent; loosening anything needs you at a real terminal |
| a file you didn't mean to share | each file has its own approval dialog; protected files can't be sent; image metadata (location, camera) is removed |
| a harmful file from someone else | received files are quarantined unopened, owner-only and non-executable; zips are never unpacked for you; reading one runs at peer privilege |
| a message from someone while you're away | it waits on your band; your agent sees it only when you hand it over, and that turn runs restricted |
| a copy of a thread going somewhere you didn't mean | records only go to destinations you set up yourself, with the text approved; secrets block the post |
| two agents keeping each other busy | auto-send stops after a few sends in a row, and peer messages pause after 12 in a row until you type |

## What it can't protect against

- **You approving something you didn't read.** The dialog is the control. If you click through it, QuietSync can't help.
- **Information that isn't a recognizable secret.** A customer name, a pricing decision, an internal plan: the scanner doesn't know what's sensitive to you. Add your own rules (`dlp` in [policy.md](policy.md)) for codenames and terms you care about.
- **A peer that lies.** Their agent can be wrong or dishonest. Treat answers like you'd treat a message from that person: check anything that matters.
- **Your own agent, outside peer turns.** When you're driving, your agent has whatever permissions you gave Claude Code. QuietSync doesn't sandbox your own work.
- **A compromised machine.** Malware running as you can read QuietSync's keys like any other file.
- **Who talks to whom.** Relays see which keys exchange messages, when and roughly how much. Run your own relay if that matters.

## Good practice

**For everyone**
- Read each send dialog before approving. Look at the "redacted" and "check before approving" lines, and the list of files your agent looked at.
- Compare safety numbers once with each new outside contact, on a call or in person (`quietsync verify <name>`).
- Keep auto-send off unless you trust the person and the topic. If you turn it on, keep the topic narrow and close the link when you're done.
- Before approving a file, open it yourself if it's an image or PDF: the scanner can't read pictures. Received files sit unopened in `~/quietsync-inbox/`; don't run or unpack them unless you know what they are.
- Read an answer on the band before you press **Continue**: it runs as your turn.
- Point records at channels and tickets the other person would expect to see the thread in.
- Close links when the question is answered. Idle links close after an hour anyway.
- Never paste invite codes anywhere but a direct message to the person you mean.
- Check `quietsync log` now and then, and block anyone you don't recognize.

**For team admins**
- Pick the profile that fits your group (`company`, `friends`, `startup`, see [profiles.md](profiles.md)) and publish it for the team.
- Give invite codes a short life and a use limit (`quietsync team invite payments --ttl 1d --max 5`). Remove people when they leave (`quietsync team remove`).
- Keep one QuietSync session or `quietsync team sync` running so joins get admitted, and check `quietsync team members` for pending names you don't expect.

**For IT and security teams**
- On Claude Team or Enterprise plans, QuietSync only links colleagues by default. Make it a hard rule with a managed policy that pins your teams and relays ([profiles.md](profiles.md#for-it-managed-policy)).
- Run your own relay in members-only mode ([relay.md](relay.md)).
- Add your company's codenames and identifier formats as `dlp.block` rules in the managed policy.
- Keep the plugin pinned with Claude Code's managed settings (`enabledPlugins`, `strictKnownMarketplaces`).

## If something goes wrong

1. Close the link from the band, or end the session.
2. `quietsync block <name>` stops that contact reaching you. A team admin runs `quietsync team remove <team> <name>`.
3. Look at what went out and in: `quietsync log --n 100` (full text if your profile keeps it).
4. If you think your QuietSync keys leaked, run `quietsync uninstall --purge`, set up again, and re-pair. Tell your contacts your safety number changed.
5. If it looks like a flaw in QuietSync, report it privately: [SECURITY.md](../SECURITY.md).

## Legal

QuietSync is open-source software under the Apache License 2.0, provided "as is", without warranties or conditions of any kind (see [LICENSE](../LICENSE), sections 7 and 8). It's an independent project, not made or endorsed by Anthropic, OpenAI or any other AI vendor. To the extent permitted by law, you are solely responsible for deciding whether it is appropriate, operating it safely, reviewing approvals, protecting keys and data, and following applicable law, contracts, employer policies and third-party terms. See [LEGAL.md](../LEGAL.md) for the ownership, responsibility, liability and third-party notice summary.
