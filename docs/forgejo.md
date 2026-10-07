# Forgejo setup

How to send Forgejo webhooks to Hato. Using GitHub instead? See [GitHub setup](./github.md).

This assumes you've already deployed the Worker and have your `WEBHOOK_SECRET` handy (see [Setup](../README.md#setup) in the README).

## Add the webhook

In your repo (or org; site admins can also add instance-wide webhooks) go to **Settings → Webhooks → Add webhook → Forgejo**:

| Field             | Value                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Target URL        | `https://hato.<you>.workers.dev/webhook`                                                                               |
| HTTP method       | `POST`                                                                                                                 |
| POST content type | `application/json`                                                                                                     |
| Secret            | your `WEBHOOK_SECRET`                                                                                                  |
| Trigger on        | "Custom events": **Issue comments**, **Pull request comments**, **Pull request reviewed** (add whatever else you need) |

Leave the "Authorization header" field empty; Hato verifies deliveries by their signature.

Pick the **Forgejo** webhook type. The Gitea type works too, since it sends GitHub-compatible headers, but the Forgejo type is what Hato expects.

Unlike GitHub, Forgejo doesn't send anything when the webhook is created. To check the connection, open the webhook and click **Test delivery**, which sends a sample `push` event.

## What the client sees

Each event's `event` field is the `X-Forgejo-Event` header and `deliveryId` is `X-Forgejo-Delivery`. The payload is exactly what Forgejo sent. It's close to GitHub's but not identical, so if your bot handles both, watch for these differences:

| Activity                                | GitHub `event`                | Forgejo `event`                                                          |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| Comment on an issue or pull request     | `issue_comment`               | `issue_comment` (`payload.is_pull` tells them apart)                     |
| Pull request review                     | `pull_request_review`         | `pull_request_approved`, `pull_request_rejected`, `pull_request_comment` |
| Inline comment on a line of a PR's diff | `pull_request_review_comment` | none; covered by the review events above                                 |
| Webhook created / tested                | `ping`                        | `push` (from **Test delivery**)                                          |

Fields like `repository.full_name`, `comment.body`, `comment.user.login` and `comment.html_url` are the same. A review's text is in `payload.review.content` rather than `payload.review.body`.

## How deliveries are verified

The Worker checks `X-Forgejo-Signature` (the bare hex HMAC-SHA256 of the body, no `sha256=` prefix) against `WEBHOOK_SECRET`. If that header is missing it falls back to the GitHub-style `X-Hub-Signature-256`, `X-GitHub-Delivery` and `X-GitHub-Event` headers that Forgejo also sends. Redeliveries reuse the same `X-Forgejo-Delivery`, so they're stored only once.

## Self-hosted Forgejo notes

- Forgejo only delivers webhooks to hosts its `[webhook] ALLOWED_HOST_LIST` setting permits. The default (`external`) allows `*.workers.dev`, but if you point a self-hosted Forgejo at a local `wrangler dev` you'll need to allow `loopback` or `private` in `app.ini`.
- Your Forgejo server must be able to reach the Worker over HTTPS. Your client machine still needs no public address.

## Sending a test delivery locally

With `npm run dev` running:

```bash
BODY='{"action":"created","repository":{"full_name":"me/repo"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://127.0.0.1:8787/webhook \
  -H "X-Forgejo-Event: issue_comment" -H "X-Forgejo-Delivery: test-$(date +%s)" \
  -H "X-Forgejo-Signature: $SIG" --data "$BODY"
```
