# Running a relay

The relay passes sealed envelopes between people. It can't read or change them, so it holds no secrets and can run anywhere. One small process handles a whole company.

Each person picks a home relay at setup. People on different relays still talk: QuietSync delivers straight to the other person's relay. So a team can run its own, and an outside contact on a different relay just works.

## Quick test (two laptops, ten minutes)

On one machine:

```sh
bun ~/quietsync/packages/cli/dist/quietsync.mjs relay --port 8787
cloudflared tunnel --url http://localhost:8787
```

`cloudflared` prints a `https://….trycloudflare.com` address. The relay URL is the same host with `wss://` and `/v1/ws`, e.g. `wss://quiet-fox-123.trycloudflare.com/v1/ws`. Quick tunnels are fine for trying it out, not for daily use: the URL changes every time.

## Docker

```sh
docker build -f packages/relay/Dockerfile -t quietsync-relay .
docker run -d --name quietsync-relay -p 8787:8787 -v quietsync-relay:/data quietsync-relay
```

The image builds the CLI and relay from source using pinned Bun 1.4.4, then runs Bun on Alpine as a non-root user. It keeps its queue and team directory in `/data/relay.sqlite` and has a health check on `/healthz`. A local prebuild is not required.

## TLS

Put it behind anything that terminates TLS and passes WebSockets. With Caddy:

```
quietsync.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Start the relay with `--trust-proxy` (or `QUIETSYNC_TRUST_PROXY=1`) so per-IP limits use `X-Forwarded-For`. Clients refuse plain `ws://` except to localhost, unless a user sets `allowInsecureRelays` for a trusted LAN.

## Fly.io

Untested recipe; corrections welcome.

```sh
fly launch --dockerfile packages/relay/Dockerfile --internal-port 8787 --no-deploy
fly volumes create quietsync_data --size 1
# in fly.toml: [mounts] source = "quietsync_data", destination = "/data"
fly deploy
```

Fly terminates TLS for you; the URL is `wss://<app>.fly.dev/v1/ws`.

## Members-only

By default anyone with a key can use a relay. For a company relay, list who gets a mailbox:

```sh
quietsync relay --allow-keys /etc/quietsync/members.txt
```

One signing key per line (the `sign` field of `~/.quietsync/identity.json`'s card, or a contact's id). Admitted members of teams created on this relay are added automatically. `SIGHUP` reloads the file.

Everyone else is a guest: they can deliver to members (so outside contacts still reach you), but they get no mailbox, no offline queue and no team directory.

## Settings

| flag / env | default | |
|---|---|---|
| `--port`, `PORT` | 8787 | |
| `--host`, `HOST` | 127.0.0.1 | use 0.0.0.0 in containers |
| `--db`, `QUIETSYNC_RELAY_DB` | in memory | SQLite file for the offline queue and team directory |
| `--allow-keys`, `QUIETSYNC_RELAY_ALLOW_KEYS` | open | members-only mode |
| `--trust-proxy`, `QUIETSYNC_TRUST_PROXY=1` | off | read client IPs from `X-Forwarded-For` |
| `--public-host`, `QUIETSYNC_PUBLIC_HOST` | the request's `Host` | the host name clients dial, if your proxy rewrites `Host`; logins are signed for it |

Built-in limits: 32 connections per key, 20 requests a second per connection (burst 60), 1200 new connections a minute per IP (burst 200), 256 KB per envelope, 1000 queued envelopes per recipient, 100 per sender to a given recipient, 200,000 total, queued envelopes kept 7 days.

## Monitoring

- `GET /healthz`: JSON with connections, keys, queue size, delivered and rejected counts
- `GET /metrics`: the same in Prometheus text format

## What the operator can and can't see

Can: which keys connect, from which IPs, who sends to whom, when and how much, and team membership records (they're public within the team directory).

Can't: message content, topics, names in messages, or anything inside an envelope. Can't forge messages, add team members or remove them.

A hostile relay can drop or delay messages, and could hold back a team revocation from clients. If that matters to you, run your own.

## Scaling

One process holds every connection in memory and routes in-process. That's plenty for thousands of people. Past that, the routing map becomes a pub/sub (Redis, NATS) and the SQLite queue a shared store; the wire protocol doesn't change.
