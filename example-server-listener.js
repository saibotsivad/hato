import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

const RELAY_URL = process.env.RELAY_URL
const CLIENT_TOKEN = process.env.CLIENT_TOKEN
const BOT_NAME = process.env.BOT_NAME ?? ''
const STATE_FILE = path.resolve(process.env.STATE_FILE ?? '.relay-state.json')

if (!RELAY_URL || !CLIENT_TOKEN) {
	console.error('Set RELAY_URL and CLIENT_TOKEN (see .env.example).')
	process.exit(1)
}

const connectUrl = new URL('/connect', RELAY_URL)
connectUrl.protocol = connectUrl.protocol === 'http:' ? 'ws:' : 'wss:'

// ---------------------------------------------------------------------------
// Your bot logic goes here. Throwing leaves the event un-acked, so it will be
// replayed on the next connection.
// ---------------------------------------------------------------------------
function handleEvent({ seq, event, payload }) {
	const repo = payload.repository?.full_name ?? ''
	const action = payload.action ? `.${payload.action}` : ''
	const comment = payload.comment ?? payload.review
	const body = comment?.body ?? ''
	const mentioned = BOT_NAME && body.includes(`@${BOT_NAME}`)

	console.log(
		`${mentioned ? '🔔' : '•'} #${seq} ${event}${action} ${repo}` +
			(comment ? ` by ${comment.user?.login}: ${body.slice(0, 200)}` : ''),
	)
	if (mentioned) console.log(`   ${comment.html_url}`)
	if (event === 'ping') console.log(`   GitHub says: "${payload.zen}"`)
}

// ---------------------------------------------------------------------------
// Cursor persistence: the seq of the last event we finished handling.
// ---------------------------------------------------------------------------
function loadCursor() {
	try {
		return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastSeq ?? 0
	} catch {
		return 0
	}
}

function saveCursor(seq) {
	const tmp = `${STATE_FILE}.tmp`
	fs.writeFileSync(tmp, JSON.stringify({ lastSeq: seq }))
	fs.renameSync(tmp, STATE_FILE) // atomic replace
}

// ---------------------------------------------------------------------------
// Connection loop with heartbeat and exponential backoff.
// ---------------------------------------------------------------------------
let lastSeq = loadCursor()
let attempt = 0
let stopping = false
let socket

function connect() {
	const ws = new WebSocket(connectUrl, {
		headers: { Authorization: `Bearer ${CLIENT_TOKEN}` },
	})
	socket = ws
	let heartbeat
	let lastSeen = Date.now()

	ws.on('open', () => {
		attempt = 0
		console.log(`Connected to ${connectUrl.host}, resuming after #${lastSeq}`)
		ws.send(JSON.stringify({ type: 'resume', after: lastSeq }))

		heartbeat = setInterval(() => {
			if (Date.now() - lastSeen > 60_000) {
				console.warn('No response from relay in 60s, reconnecting')
				return ws.terminate()
			}
			ws.send('ping')
		}, 25_000)
	})

	ws.on('message', (data) => {
		lastSeen = Date.now()
		const text = data.toString()
		if (text === 'pong') return

		let msg
		try {
			msg = JSON.parse(text)
		} catch {
			return
		}

		if (msg.type === 'ready') {
			if (msg.replayed) console.log(`Caught up on ${msg.replayed} missed event(s)`)
			return
		}
		if (msg.type !== 'event' || msg.seq <= lastSeq) return

		try {
			handleEvent(msg)
		} catch (err) {
			console.error(`Handler failed on #${msg.seq}, will retry on reconnect:`, err)
			return ws.terminate()
		}
		lastSeq = msg.seq
		saveCursor(lastSeq) // persist first, then ack
		ws.send(JSON.stringify({ type: 'ack', seq: lastSeq }))
	})

	ws.on('unexpected-response', (_req, res) => {
		console.error(`Relay refused the connection: HTTP ${res.statusCode}`)
		if (res.statusCode === 401) {
			console.error("Check that CLIENT_TOKEN matches the Worker's secret.")
		}
	})

	ws.on('error', (err) => console.error('WebSocket error:', err.message))

	ws.on('close', (code, reason) => {
		clearInterval(heartbeat)
		if (stopping) return
		if (code === 4000) {
			console.error('Another client connected and replaced this one. Exiting.')
			process.exit(1)
		}
		const delay = Math.min(30_000, 1000 * 2 ** attempt++) * (0.5 + Math.random() / 2)
		console.log(
			`Disconnected (${code}${reason.length ? ` ${reason}` : ''}), retrying in ${Math.round(delay / 1000)}s`,
		)
		setTimeout(connect, delay)
	})
}

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		stopping = true
		socket?.close(1000, 'client shutting down')
		setTimeout(() => process.exit(0), 500)
	})
}

connect()
