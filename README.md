# Hato

![](./hato-pigeon-courier.png)

Hato (鳩 in [Japanese](https://www.nihongomaster.com/japanese/dictionary/word/45981/hato-hato-%E9%B3%A9-%E9%B4%BF-%E3%81%AF%E3%81%A8-%E3%83%8F%E3%83%88)) is a Courier pigeon that receives GitHub or Forgejo webhooks to a Cloudflare Worker and streams them to an on-premises application of your choosing over a WebSocket. Your machine never needs a public address or open ports, and events that arrive while it's offline are buffered and replayed when it reconnects.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/saibotsivad/hato)

```
GitHub/Forgejo(POST /webhook) ──▶ Worker ──▶ Durable Object (SQLite buffer) ◀── Computer(WebSocket)
```

## How it works

- The Worker verifies each delivery's signature (`X-Hub-Signature-256` from GitHub, `X-Forgejo-Signature` from Forgejo) and hands it to a single Durable Object.
- The Durable Object stores the event in its built-in SQLite database, then pushes it to the connected client.
- The client handles the event, saves its position to disk, and sends an ack. Acked events are deleted.
- On reconnect, the client tells the relay the last event it handled and gets everything after it, in order.
- Duplicate deliveries (retries, manual "Redeliver") are ignored using the delivery ID (`X-GitHub-Delivery` or `X-Forgejo-Delivery`).
- Events nobody acknowledges are deleted after `RETENTION_DAYS` (default 7).
- WebSocket hibernation is used, so an idle connection costs almost nothing.

Delivery is **at-least-once**: if your handler crashes mid-event, that event is replayed. Design your bot logic so handling the same event twice is safe.

## Non Goals

- Multiple organizations: this is not a packaged SaaS, it's meant to help you manage your handful of repositories
- Very large teams: it uses a single Durable Object instance and SQLite database, that will be a big bottleneck

## Setup

### 1. Deploy the Worker

Click the button above. During setup you'll be asked for two secrets; generate each with:

```bash
openssl rand -hex 32
```

- `WEBHOOK_SECRET`: shared with GitHub or Forgejo to sign deliveries.
- `CLIENT_TOKEN`: used by your local client to connect.

Keep both handy. When it finishes you'll have a URL like `https://hato.<you>.workers.dev`.

<details>
<summary>Deploying manually with Wrangler instead</summary>

```bash
npm install
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put CLIENT_TOKEN
npm run deploy
```

</details>

### 2. Add the webhook

Follow the guide for your forge:

- [GitHub setup](./docs/github.md)
- [Forgejo setup](./docs/forgejo.md)

### 3. Run the client

Requires Node.js 20.6 or newer.

```bash
cd client
npm install
cp .env.example .env   # then fill in RELAY_URL and CLIENT_TOKEN
npm start
```

You should see it connect, then live events as they arrive. The forge guides above show what to expect from each.

Put your bot's logic in `handleEvent()` in `client/index.js`.

## Endpoints

| Path            | Auth                                   | Purpose                                   |
| --------------- | -------------------------------------- | ----------------------------------------- |
| `POST /webhook` | GitHub or Forgejo signature            | Receives deliveries                       |
| `GET /connect`  | `Authorization: Bearer <CLIENT_TOKEN>` | WebSocket for the client                  |
| `GET /status`   | `Authorization: Bearer <CLIENT_TOKEN>` | Pending event count and connected clients |

```bash
curl -H "Authorization: Bearer $CLIENT_TOKEN" https://hato.<you>.workers.dev/status
```

## Notes

- **One client at a time.** Acks delete events, so this is a single-consumer queue. A new connection replaces the old one, and the replaced client exits rather than fighting over the connection.
- **Client state** is stored in `client/.relay-state.json`. Deleting it is safe: the client will receive whatever is still unacknowledged.
- **Payload size.** A single stored event is limited to about 2 MB by Durable Object SQLite. Normal comment and PR events are far smaller than this, but very large `push` events could exceed it.
- **Treat comment text as untrusted input.** Anyone who can comment on your repo controls it. Never pass it to a shell or `eval`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in any values
npm install
npm run dev                      # http://127.0.0.1:8787
```

Point the client at `RELAY_URL=http://127.0.0.1:8787`. To send a signed test webhook, see the GitHub or Forgejo guide above ([GitHub](./docs/github.md#sending-a-test-delivery-locally), [Forgejo](./docs/forgejo.md#sending-a-test-delivery-locally)).
