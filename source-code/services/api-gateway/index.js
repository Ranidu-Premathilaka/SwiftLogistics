const http      = require('http');
const httpProxy = require('http-proxy');
const jwt       = require('jsonwebtoken');
const config    = require('./config');

const { port: PORT, jwtSecret: JWT_SECRET, serviceMap: SERVICE_MAP, publicPrefixes: PUBLIC_PREFIXES } = config;

const proxy = httpProxy.createProxyServer({});

proxy.on('error', (err, req, resOrSocket) => {
    console.error(`[API Gateway] Proxy error: ${err.message}`);
    if (resOrSocket.writeHead) {
        resOrSocket.writeHead(502, { 'Content-Type': 'application/json' });
        resOrSocket.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    } else {
        resOrSocket.destroy();
    }
});

function isPublic(url) {
    return PUBLIC_PREFIXES.some(prefix => url === prefix || url.startsWith(prefix));
}

function validateToken(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer '))
        throw Object.assign(new Error('Missing or malformed Authorization header'), { status: 401 });

    const token = authHeader.slice(7);
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
    }
}

function resolveTarget(url) {
    const parts       = url.split('/').filter(Boolean);
    const serviceName = parts[0];
    const serviceBase = SERVICE_MAP[serviceName];
    if (!serviceBase) return null;

    // Strip the service prefix from the path before forwarding
    const remaining = '/' + parts.slice(1).join('/');
    return { target: serviceBase, path: remaining };
}

const server = http.createServer((req, res) => {
    const { method, url } = req;
    console.log(`[API Gateway] ${method} ${url}`);

    if (method === 'GET' && url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok' }));
    }

    if (!isPublic(url)) {
        try {
            const payload = validateToken(req);
            if (payload.username) req.headers['x-username'] = payload.username;
            if (payload.role)     req.headers['x-role']     = payload.role;
        } catch (err) {
            res.writeHead(err.status || 401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    const resolved = resolveTarget(url);
    if (!resolved) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Unknown service: ${url.split('/')[1]}` }));
    }

    console.log(`[API Gateway] Routing to ${resolved.target}${resolved.path}`);
    req.url = resolved.path;
    proxy.web(req, res, { target: resolved.target });
});

server.on('upgrade', (req, socket, head) => {
    console.log(`[API Gateway] WS UPGRADE ${req.url}`);

    if (!isPublic(req.url)) {
        try {
            const payload = validateToken(req);
            if (payload.username) req.headers['x-username'] = payload.username;
            if (payload.role)     req.headers['x-role']     = payload.role;
        } catch (err) {
            socket.write(`HTTP/1.1 ${err.status || 401} Unauthorized\r\nConnection: close\r\n\r\n`);
            socket.destroy();
            return;
        }
    }

    const resolved = resolveTarget(req.url);
    if (!resolved) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
    }

    req.url = resolved.path;
    proxy.ws(req, socket, head, { target: resolved.target });
});

server.listen(PORT, () => {
    console.log(`[API Gateway] Listening on port ${PORT}`);
});
