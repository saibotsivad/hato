# github-webhook-relay

Receive GitHub webhooks on a Cloudflare Worker and stream them to a program on your own computer over a WebSocket. Your machine never needs a public address or open ports, and events that arrive while it's offline are buffered and replayed when it reconnects.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR-USERNAME/github-webhook-relay)

```
GitHub ──POST /webhook──▶ Worker ──▶ Durable Object (SQLite buffer) ◀──WebSocket── your computer
```

## How it works

- The Worker verifies each delivery's `X-Hub-Signature-256` and hands it to a single Durable Object.
- The Durable Object stores the event in its built-in SQLite database, then pushes it to the connected client.
- The client handles the event, saves its position to disk, and sends an ack. Acked events are deleted.
- On reconnect, the client tells the relay the last event it handled and gets everything after it, in order.
- Duplicate deliveries (GitHub retries, manual "Redeliver") are ignored using `X-GitHub-Delivery`.
- Events nobody acknowledges are deleted after `RETENTION_DAYS` (default 7).
- WebSocket hibernation is used, so an idle connection costs almost nothing.

Delivery is **at-least-once**: if your handler crashes mid-event, that event is replayed. Design your bot logic so handling the same event twice is safe.

## Setup

### 1. Deploy the Worker

Click the button above. During setup you'll be asked for two secrets; generate each with:

```bash
openssl rand -hex 32
```

- `WEBHOOK_SECRET`: shared with GitHub to sign deliveries.
- `CLIENT_TOKEN`: used by your local client to connect.

Keep both handy. When it finishes you'll have a URL like `https://github-webhook-relay.<you>.workers.dev`.

<details>
<summary>Deploying manually with Wrangler instead</summary>

```bash
npm install
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put CLIENT_TOKEN
npm run deploy
```
</details>

### 2. Add the webhook in GitHub

In your repo (or org, or GitHub App) go to **Settings → Webhooks → Add webhook**:

| Field | Value |
| --- | --- |
| Payload URL | `https://github-webhook-relay.<you>.workers.dev/webhook` |
| Content type | `application/json` |
| Secret | your `WEBHOOK_SECRET` |
| Events | "Let me select individual events": **Issue comments**, **Pull request review comments**, **Pull request reviews** (add whatever else you need) |

GitHub sends a `ping` event immediately; it'll be waiting for your client.

### 3. Run the client

Requires Node.js 20.6 or newer.

```bash
cd client
npm install
cp .env.example .env   # then fill in RELAY_URL and CLIENT_TOKEN
npm start
```

You should see the ping, then live events:

```
Connected to github-webhook-relay.you.workers.dev, resuming after #0
• #1 ping me/repo
   GitHub says: "Keep it logically awesome."
Caught up on 1 missed event(s)
🔔 #2 issue_comment.created me/repo by alice: @foo-bot check this function
   https://github.com/me/repo/pull/1#issuecomment-123
```

Put your bot's logic in `handleEvent()` in `client/index.js`.

## Endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `POST /webhook` | GitHub signature | Receives deliveries |
| `GET /connect` | `Authorization: Bearer <CLIENT_TOKEN>` | WebSocket for the client |
| `GET /status` | `Authorization: Bearer <CLIENT_TOKEN>` | Pending event count and connected clients |

```bash
curl -H "Authorization: Bearer $CLIENT_TOKEN" https://github-webhook-relay.<you>.workers.dev/status
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

Point the client at `RELAY_URL=http://127.0.0.1:8787`. To send a signed test webhook:

```bash
BODY='{"zen":"hello","repository":{"full_name":"me/repo"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://127.0.0.1:8787/webhook \
  -H "X-GitHub-Event: ping" -H "X-GitHub-Delivery: test-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=$SIG" --data "$BODY"
```
