import { DurableObject } from 'cloudflare:workers'

export interface Env {
	HUB: DurableObjectNamespace<EventHub>
	WEBHOOK_SECRET: string
	CLIENT_TOKEN: string
	RETENTION_DAYS: string
}

// ---------------------------------------------------------------------------
// Worker: verifies and routes requests. All state lives in one Durable Object.
// ---------------------------------------------------------------------------

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url)
		const hub = env.HUB.get(env.HUB.idFromName('main'))

		// GitHub -> relay
		if (url.pathname === '/webhook' && request.method === 'POST') {
			const body = await request.text()
			const valid = await verifyGitHubSignature(
				env.WEBHOOK_SECRET,
				body,
				request.headers.get('X-Hub-Signature-256'),
			)
			if (!valid) return new Response('invalid signature', { status: 401 })

			const deliveryId = request.headers.get('X-GitHub-Delivery')
			const event = request.headers.get('X-GitHub-Event')
			if (!deliveryId || !event) {
				return new Response('missing GitHub headers', { status: 400 })
			}

			const result = await hub.ingest(deliveryId, event, body)
			return Response.json(result, { status: 202 })
		}

		// Local client -> relay (WebSocket)
		if (url.pathname === '/connect') {
			if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
				return new Response('expected a WebSocket upgrade', { status: 426 })
			}
			if (!(await isAuthorized(request, env))) {
				return new Response('unauthorized', { status: 401 })
			}
			return hub.fetch(request)
		}

		// Quick health check for debugging
		if (url.pathname === '/status') {
			if (!(await isAuthorized(request, env))) {
				return new Response('unauthorized', { status: 401 })
			}
			return Response.json(await hub.status())
		}

		if (url.pathname === '/') {
			return new Response(
				'github-webhook-relay is running.\n' +
					'Point your GitHub webhook at /webhook and your client at /connect.\n',
			)
		}

		return new Response('not found', { status: 404 })
	},
} satisfies ExportedHandler<Env>

// ---------------------------------------------------------------------------
// Durable Object: stores events in SQLite and pushes them over a WebSocket.
//
// Protocol (JSON text messages):
//   client -> hub  {"type":"resume","after":<seq>}   replay everything after seq
//   hub -> client  {"type":"event","seq":..,"event":..,"deliveryId":..,"payload":..}
//   client -> hub  {"type":"ack","seq":<seq>}         delete everything <= seq
//   client -> hub  "ping"                             answered with "pong"
//                                                     (without waking the DO)
// ---------------------------------------------------------------------------

type SocketState = { ready: boolean }

export class EventHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT    NOT NULL UNIQUE,
        event       TEXT    NOT NULL,
        payload     TEXT    NOT NULL,
        received_at INTEGER NOT NULL
      )
    `)
		// Heartbeats are answered by the runtime, so they don't wake a hibernating DO.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
	}

	/** Store a webhook delivery, then push it to any connected client. */
	async ingest(deliveryId: string, event: string, payload: string) {
		const receivedAt = Date.now()
		const rows = this.ctx.storage.sql
			.exec<{ seq: number }>(
				`INSERT INTO events (delivery_id, event, payload, received_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING
         RETURNING seq`,
				deliveryId,
				event,
				payload,
				receivedAt,
			)
			.toArray()

		// GitHub retried or someone clicked "Redeliver": already stored.
		if (rows.length === 0) return { stored: false, duplicate: true }

		const seq = rows[0].seq
		const message = formatEvent(seq, deliveryId, event, payload, receivedAt)
		for (const ws of this.ctx.getWebSockets()) {
			// Only push live events to clients that have finished their replay,
			// so events always arrive in order.
			if ((ws.deserializeAttachment() as SocketState | null)?.ready) {
				trySend(ws, message)
			}
		}

		await this.scheduleCleanup()
		return { stored: true, seq }
	}

	async status() {
		const row = this.ctx.storage.sql
			.exec<{ pending: number; oldest: number | null }>(
				'SELECT COUNT(*) AS pending, MIN(received_at) AS oldest FROM events',
			)
			.one()
		return {
			pendingEvents: row.pending,
			oldestPendingAt: row.oldest ? new Date(row.oldest).toISOString() : null,
			connectedClients: this.ctx.getWebSockets().length,
		}
	}

	/** WebSocket upgrade (already authenticated by the Worker). */
	async fetch(): Promise<Response> {
		// Single-consumer design: a new connection replaces any old (possibly
		// half-dead) one, since acks delete events.
		for (const old of this.ctx.getWebSockets()) {
			try {
				old.close(4000, 'replaced by a newer connection')
			} catch {
				// Already closed.
			}
		}

		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({ ready: false } satisfies SocketState)
		return new Response(null, { status: 101, webSocket: client })
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
		let msg: { type?: string; after?: unknown; seq?: unknown }
		try {
			msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
		} catch {
			return
		}

		if (msg.type === 'resume') {
			const after = Number(msg.after) || 0
			// Anything at or before the client's cursor was already handled.
			this.ctx.storage.sql.exec('DELETE FROM events WHERE seq <= ?', after)

			const backlog = this.ctx.storage.sql.exec<{
				seq: number
				delivery_id: string
				event: string
				payload: string
				received_at: number
			}>('SELECT * FROM events WHERE seq > ? ORDER BY seq', after)

			let replayed = 0
			for (const row of backlog) {
				trySend(
					ws,
					formatEvent(row.seq, row.delivery_id, row.event, row.payload, row.received_at),
				)
				replayed++
			}
			ws.serializeAttachment({ ready: true } satisfies SocketState)
			trySend(ws, JSON.stringify({ type: 'ready', replayed }))
		} else if (msg.type === 'ack') {
			const seq = Number(msg.seq)
			if (Number.isFinite(seq)) {
				this.ctx.storage.sql.exec('DELETE FROM events WHERE seq <= ?', seq)
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string) {
		try {
			ws.close(code, reason)
		} catch {
			// Already closed, or a reserved close code that can't be echoed.
		}
	}

	async webSocketError(ws: WebSocket) {
		try {
			ws.close(1011, 'error')
		} catch {
			// Already closed.
		}
	}

	/** Daily cleanup of events nobody acknowledged within RETENTION_DAYS. */
	async alarm() {
		const days = Number(this.env.RETENTION_DAYS) || 7
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
		this.ctx.storage.sql.exec('DELETE FROM events WHERE received_at < ?', cutoff)

		const { n } = this.ctx.storage.sql
			.exec<{ n: number }>('SELECT COUNT(*) AS n FROM events')
			.one()
		if (n > 0) await this.scheduleCleanup()
	}

	private async scheduleCleanup() {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000)
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEvent(
	seq: number,
	deliveryId: string,
	event: string,
	payload: string,
	receivedAt: number,
): string {
	// payload is already JSON text, so splice it in rather than re-parsing.
	return (
		`{"type":"event","seq":${seq},"deliveryId":${JSON.stringify(deliveryId)},` +
		`"event":${JSON.stringify(event)},"receivedAt":${receivedAt},"payload":${payload}}`
	)
}

function trySend(ws: WebSocket, message: string) {
	try {
		ws.send(message)
	} catch {
		// Socket is closing; the event stays in storage and is replayed on reconnect.
	}
}

const encoder = new TextEncoder()

/** Verify GitHub's X-Hub-Signature-256 header (HMAC-SHA256, constant time). */
async function verifyGitHubSignature(
	secret: string,
	body: string,
	header: string | null,
): Promise<boolean> {
	if (!secret || !header?.startsWith('sha256=')) return false
	const hex = header.slice('sha256='.length)
	if (!/^[0-9a-f]{64}$/i.test(hex)) return false

	const signature = new Uint8Array(32)
	for (let i = 0; i < 32; i++) signature[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)

	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify'],
	)
	return crypto.subtle.verify('HMAC', key, signature, encoder.encode(body))
}

/** Check "Authorization: Bearer <CLIENT_TOKEN>" in constant time. */
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
	const header = request.headers.get('Authorization') ?? ''
	const token = header.startsWith('Bearer ') ? header.slice(7) : ''
	if (!token || !env.CLIENT_TOKEN) return false

	// Hash both so the comparison is over equal-length buffers.
	const [a, b] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(token)),
		crypto.subtle.digest('SHA-256', encoder.encode(env.CLIENT_TOKEN)),
	])
	return crypto.subtle.timingSafeEqual(a, b)
}
