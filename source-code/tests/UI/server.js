const express = require('express');
const http    = require('http');
const path    = require('path');
const { WebSocket, WebSocketServer } = require('ws');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

const PORT         = process.env.PORT || 4000;
const GATEWAY_HOST = process.env.GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8081;

app.use(express.json());

// Dev dashboard at /dev
app.get('/dev', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dev.html'));
});

// Prototype client at / (default)
app.use(express.static(path.join(__dirname, 'public')));

// ── Proxy API requests to the gateway ─────────────────────────────────────────

app.all('/api/*', (req, res) => {
    const gwPath = req.originalUrl.replace(/^\/api/, '');
    const payload = ['POST', 'PATCH', 'PUT'].includes(req.method)
        ? JSON.stringify(req.body)
        : null;

    const headers = { 'Content-Type': 'application/json' };
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['x-request-id'])  headers['x-request-id']  = req.headers['x-request-id'];
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const opts = {
        hostname: GATEWAY_HOST,
        port:     GATEWAY_PORT,
        path:     gwPath,
        method:   req.method,
        headers,
    };

    const proxyReq = http.request(opts, (proxyRes) => {
        let data = '';
        proxyRes.on('data', chunk => data += chunk);
        proxyRes.on('end', () => {
            res.status(proxyRes.statusCode);
            try {
                const parsed = JSON.parse(data);
                res.json(parsed);
            } catch {
                res.set('Content-Type', 'text/plain');
                res.send(data);
            }
        });
    });

    proxyReq.on('error', (err) => {
        res.status(502).json({ error: 'Gateway unreachable', message: err.message });
    });

    if (payload) proxyReq.write(payload);
    proxyReq.end();
});

// ── WebSocket bridge ──────────────────────────────────────────────────────────
// Browser connects to our /ws, we open a companion WS to the gateway's /notify
// and relay messages back to the browser.

wss.on('connection', (browserWs, req) => {
    const url   = new URL(req.url, `http://localhost`);
    const token = url.searchParams.get('token');
    const label = url.searchParams.get('label') || 'unknown';

    if (!token) {
        browserWs.send(JSON.stringify({ type: 'error', message: 'Missing token' }));
        browserWs.close();
        return;
    }

    console.log(`[WS Bridge] Opening gateway WS for ${label}`);

    const gwWs = new WebSocket(`ws://${GATEWAY_HOST}:${GATEWAY_PORT}/notify`, {
        headers: { Authorization: `Bearer ${token}` },
    });

    gwWs.on('open', () => {
        console.log(`[WS Bridge] Gateway WS open for ${label}`);
        browserWs.send(JSON.stringify({ type: 'ws_connected', label }));
    });

    gwWs.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            browserWs.send(JSON.stringify({ type: 'ws_message', label, data: msg }));
        } catch { /* ignore */ }
    });

    gwWs.on('error', (err) => {
        console.error(`[WS Bridge] Gateway WS error for ${label}:`, err.message);
        browserWs.send(JSON.stringify({ type: 'ws_error', label, message: err.message }));
    });

    gwWs.on('close', () => {
        console.log(`[WS Bridge] Gateway WS closed for ${label}`);
        browserWs.send(JSON.stringify({ type: 'ws_closed', label }));
    });

    browserWs.on('close', () => {
        console.log(`[WS Bridge] Browser WS closed for ${label}`);
        if (gwWs.readyState === WebSocket.OPEN) gwWs.close();
    });

    browserWs.on('message', (raw) => {
        // Forward browser commands to gateway WS if needed
        if (gwWs.readyState === WebSocket.OPEN) gwWs.send(raw);
    });
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`[Test UI] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[Test UI] Gateway target: ${GATEWAY_HOST}:${GATEWAY_PORT}`);
});
