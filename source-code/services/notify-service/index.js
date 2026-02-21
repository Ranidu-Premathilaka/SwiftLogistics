const http   = require('http');
const { WebSocketServer, OPEN } = require('ws');
const config = require('./config');
const PubSub = require('../utility/pubsub');
const db     = require('../utility/db');

// ── In-memory connection store ────────────────────────────────────────────
// Supports multiple simultaneous connections per user (e.g. multiple tabs/devices)
// Map<userId: string, Set<WebSocket>>
const connections = new Map();

function addConnection(userId, ws) {
    if (!connections.has(userId)) {
        connections.set(userId, new Set());
    }
    connections.get(userId).add(ws);
}

function removeConnection(userId, ws) {
    const sockets = connections.get(userId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) connections.delete(userId);
}

function getConnections(userId) {
    return connections.get(userId) ?? new Set();
}

// ── PubSub (RabbitMQ) ─────────────────────────────────────────────────────
// Each notify-service instance gets a unique queue so that when scaled
// horizontally every instance receives all notify.* messages and can
// decide whether *its own* connected users need the notification.
const queueName = `notifier.${process.env.HOSTNAME}`;

const pubsub = new PubSub(
    config.rabbitmq.url,
    config.rabbitmq.exchange,
    queueName
);

// ── Database ──────────────────────────────────────────────────────────────
db.init();

// ── HTTP + WebSocket server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok' }));
    }
    res.writeHead(404);
    res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
    const userId = req.headers['x-username'];

    if (!userId) {
        ws.close(1008, 'Missing x-username');
        return;
    }

    console.log(`[Notify] User connected: ${userId}`);
    addConnection(userId, ws);

    // ── Flush pending notifications (event + message) ────────────────────
    try {
        const { rows } = await db.query(
            `SELECT id, type, payload
             FROM   pending_notifications
             WHERE  user_id   = $1
             AND    delivered = false
             ORDER  BY created_at ASC`,
            [userId]
        );

        if (rows.length > 0) {
            for (const row of rows) {
                if (ws.readyState === OPEN) {
                    ws.send(JSON.stringify({ type: row.type, payload: row.payload }));
                }
            }
            const ids = rows.map(r => r.id);
            await db.query(
                `UPDATE pending_notifications
                 SET    delivered = true
                 WHERE  id        = ANY($1::int[])`,
                [ids]
            );
            console.log(`[Notify] Flushed ${rows.length} pending notification(s) to ${userId}`);
        }
    } catch (err) {
        console.error('[Notify] Error flushing pending notifications:', err);
    }

    // ── Teardown ──────────────────────────────────────────────────────────
    ws.on('close', () => {
        console.log(`[Notify] User disconnected: ${userId}`);
        removeConnection(userId, ws);
    });

    ws.on('error', (err) => {
        console.error(`[Notify] Socket error for ${userId}:`, err.message);
        removeConnection(userId, ws);
    });
});

// ── RabbitMQ message handler ──────────────────────────────────────────────
async function handleNotification(message) {
    const { type, userId, payload } = message;

    if (!type || !userId || !payload) {
        console.warn('[Notify] Malformed message received:', message);
        return;
    }

    const sockets = getConnections(userId);
    const onlineSockets = [...sockets].filter(ws => ws.readyState === OPEN);

    if (onlineSockets.length > 0) {
        // Deliver to every active connection for this user
        const frame = JSON.stringify({ type, payload });
        for (const ws of onlineSockets) {
            ws.send(frame);
        }
        console.log(`[Notify] Delivered ${type} to ${userId} (${onlineSockets.length} socket(s))`);
        return;
    }

    // ── User is offline ───────────────────────────────────────────────────
    if (type === 'command') {
        // Commands are time-sensitive actions; discard when the user is offline
        console.log(`[Notify] Discarded command for offline user: ${userId}`);
        return;
    }

    // type === 'event' | 'message' -> persist for delivery on next connect
    try {
        await db.query(
            `INSERT INTO pending_notifications (user_id, type, payload)
             VALUES ($1, $2, $3)`,
            [userId, type, JSON.stringify(payload)]
        );
        console.log(`[Notify] Stored pending ${type} for offline user: ${userId}`);
    } catch (err) {
        console.error('[Notify] Error storing pending notification:', err);
    }
}

// ── Startup ───────────────────────────────────────────────────────────────
async function start() {
    await pubsub.connect();
    await pubsub.subscribe('notify.*', handleNotification);

    server.listen(config.port, () => {
        console.log(`[Notify] Listening on port ${config.port} (queue: ${queueName})`);
    });
}

start();
