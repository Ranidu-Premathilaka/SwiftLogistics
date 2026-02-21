const http   = require('http');
const jwt    = require('jsonwebtoken');
const config = require('./config');

const { port: PORT, jwtSecret: JWT_SECRET, serviceMap: SERVICE_MAP, publicPrefixes: PUBLIC_PREFIXES } = config;

function isPublic(url) {
    return PUBLIC_PREFIXES.some(prefix => url === prefix || url.startsWith(prefix));
}

function validateToken(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer '))
        throw Object.assign(new Error('Missing or malformed Authorization header'), { status: 401 });

    const token = authHeader.slice(7);
    try {
        return jwt.verify(token, JWT_SECRET); // returns decoded payload
    } catch (err) {
        throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
    }
}

function proxyRequest(targetUrl, req, res) {
    const url = new URL(targetUrl);

    const options = {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + (url.search || ''),
        method: req.method,
        headers: {
            ...req.headers,
            host: url.hostname,
        },
    };

    const proxy = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxy.on('error', (err) => {
        console.error(`[API Gateway] Proxy error: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    });

    req.pipe(proxy, { end: true });
}

const server = http.createServer((req, res) => {
    const { method, url } = req;

    console.log(`[API Gateway] ${method} ${url}`);

    // Health check
    if (method === 'GET' && url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok' }));
    }

    // JWT validation for protected routes
    if (!isPublic(url)) {
        try {
            const payload = validateToken(req);
            req.headers['x-username'] = payload.username;
            req.headers['x-role'] = payload.role;
        } catch (err) {
            res.writeHead(err.status || 401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // Resolve service from first path segment
    // e.g. /order/create  →  service: 'order', downstream path: /create
    const parts = url.split('/').filter(Boolean); // ['order', 'create']
    const serviceName = parts[0];                 // 'order'
    const remainingPath = '/' + parts.slice(1).join('/'); // '/create'

    const serviceBase = SERVICE_MAP[serviceName];

    if (!serviceBase) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Unknown service: ${serviceName}` }));
    }

    const targetUrl = serviceBase + remainingPath;
    console.log(`[API Gateway] Routing to ${targetUrl}`);

    proxyRequest(targetUrl, req, res);
});

server.listen(PORT, () => {
    console.log(`[API Gateway] Listening on port ${PORT}`);
});
