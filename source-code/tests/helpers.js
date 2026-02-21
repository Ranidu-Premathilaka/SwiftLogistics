/**
 * Shared HTTP helper for tests.
 * Makes JSON requests to the API Gateway and returns { status, body }.
 */

const http = require('http');

const GATEWAY_HOST = process.env.GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8081;

function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;

        const options = {
            hostname: GATEWAY_HOST,
            port:     GATEWAY_PORT,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers,
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        };

        logRequest(method, path, body, headers);

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    logResponse(res.statusCode, parsed);
                    resolve({ status: res.statusCode, body: parsed });
                } catch {
                    logResponse(res.statusCode, data);
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// ── Test runner helpers ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
    console.log(`\n  ▸ ${name}`);
    try {
        await fn();
        console.log(`  ✓ passed`);
        passed++;
    } catch (err) {
        console.error(`  ✗ failed: ${err.message}`);
        failed++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function logRequest(method, path, body, headers) {
    console.log(`     ↑ ${method} ${path}`);
    if (body)                         console.log(`       body:    ${JSON.stringify(body)}`);
    const safeHeaders = { ...headers };
    if (safeHeaders['Authorization']) safeHeaders['Authorization'] = safeHeaders['Authorization'].slice(0, 20) + '…';
    if (Object.keys(safeHeaders).length) console.log(`       headers: ${JSON.stringify(safeHeaders)}`);
}

function logResponse(status, body) {
    console.log(`     ↓ ${status} ${JSON.stringify(body)}`);
}

function summary() {
    console.log(`\n  ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

module.exports = { request, test, assert, summary, logRequest, logResponse };
