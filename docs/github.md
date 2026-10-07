# GitHub setup

How to send GitHub webhooks to Hato. Using Forgejo instead? See [Forgejo setup](./forgejo.md).

This assumes you've already deployed the Worker and have your `WEBHOOK_SECRET` handy (see [Setup](../README.md#setup) in the README).

## Add the webhook

In your repo (or org, or GitHub App) go to **Settings → Webhooks → Add webhook**:

| Field        | Value                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload URL  | `https://hato.<you>.workers.dev/webhook`                                                                                                       |
| Content type | `application/json`                                                                                                                             |
| Secret       | your `WEBHOOK_SECRET`                                                                                                                          |
| Events       | "Let me select individual events": **Issue comments**, **Pull request review comments**, **Pull request reviews** (add whatever else you need) |

GitHub sends a `ping` event immediately; it'll be waiting for your client.

## What the client sees

Once the client is running you should see the ping, then live events:

```
Connected to hato.<you>.workers.dev, resuming after #0
• #1 ping me/repo
   GitHub says: "Keep it logically awesome."
Caught up on 1 missed event(s)
🔔 #2 issue_comment.created me/repo by alice: @foo-bot check this function
   https://github.com/me/repo/pull/1#issuecomment-123
```

Each event's `event` field is the `X-GitHub-Event` header (`issue_comment`, `pull_request_review`, `pull_request_review_comment`, …) and `deliveryId` is `X-GitHub-Delivery`. The payload is exactly what GitHub sent; see GitHub's [webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) reference.

## How deliveries are verified

The Worker checks `X-Hub-Signature-256` (`sha256=<hex HMAC of the body>`) against `WEBHOOK_SECRET`. Retries and manual "Redeliver" clicks reuse the same `X-GitHub-Delivery`, so they're stored only once.

## Sending a test delivery locally

With `npm run dev` running:

```bash
BODY='{"zen":"hello","repository":{"full_name":"me/repo"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://127.0.0.1:8787/webhook \
  -H "X-GitHub-Event: ping" -H "X-GitHub-Delivery: test-$(date +%s)" \
  -H "X-Hub-Signature-256: sha256=$SIG" --data "$BODY"
```
