/**
 * Shared HTTP helper for tests.
 * Makes JSON requests to the API Gateway and returns { status, body }.
 */

const http = require('http');

const GATEWAY_HOST = process.env.GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8081;

// ── ANSI colours ──────────────────────────────────────────────────────────────
const c = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    green:   '\x1b[32m',
    red:     '\x1b[31m',
    yellow:  '\x1b[33m',
    cyan:    '\x1b[36m',
    magenta: '\x1b[35m',
    blue:    '\x1b[34m',
    white:   '\x1b[37m',
    gray:    '\x1b[90m',
};

const METHOD_COLOR = { GET: c.cyan, POST: c.green, PATCH: c.yellow, DELETE: c.red };

function statusColor(code) {
    if (code >= 500) return c.red;
    if (code >= 400) return c.yellow;
    if (code >= 200) return c.green;
    return c.white;
}

function fmt(obj) {
    return JSON.stringify(obj, null, 2)
        .split('\n')
        .map((l, i) => i === 0 ? l : `             ${l}`)
        .join('\n');
}

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
    console.log(`\n  ${c.bold}${c.blue}◆ ${name}${c.reset}`);
    console.log(`  ${c.gray}${'─'.repeat(name.length + 2)}${c.reset}`);
    try {
        await fn();
        console.log(`  ${c.green}${c.bold}✔ passed${c.reset}`);
        passed++;
    } catch (err) {
        console.error(`  ${c.red}${c.bold}✘ failed:${c.reset} ${c.red}${err.message}${c.reset}`);
        failed++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function logRequest(method, path, body, headers) {
    const col = METHOD_COLOR[method] || c.white;
    console.log(`     ${c.bold}${col}↑ ${method}${c.reset}  ${c.gray}${path}${c.reset}`);
    if (body) {
        console.log(`     ${c.gray}body:${c.reset}    ${fmt(body)}`);
    }
    const safeHeaders = { ...headers };
    if (safeHeaders['Authorization']) {
        safeHeaders['Authorization'] = safeHeaders['Authorization'].slice(0, 24) + '…';
    }
    if (Object.keys(safeHeaders).length) {
        console.log(`     ${c.gray}headers:${c.reset} ${fmt(safeHeaders)}`);
    }
}

function logResponse(status, body) {
    const col     = statusColor(status);
    const bodyStr = typeof body === 'string' ? `"${body}"` : fmt(body);
    console.log(`     ${c.bold}↓${c.reset} ${col}${c.bold}${status}${c.reset}  ${bodyStr}`);
}

function summary() {
    const total = passed + failed;
    const bar   = '═'.repeat(42);
    console.log(`\n  ${c.gray}${bar}${c.reset}`);
    console.log(`  ${c.bold}   Results${c.reset}  ${c.gray}(${total} test${total !== 1 ? 's' : ''})${c.reset}`);
    console.log(`  ${c.gray}${bar}${c.reset}`);
    console.log(`  ${c.green}${c.bold}  ✔ Passed${c.reset}   ${passed}`);
    if (failed > 0) {
        console.log(`  ${c.red}${c.bold}  ✘ Failed${c.reset}   ${failed}`);
    }
    console.log(`  ${c.gray}${bar}${c.reset}\n`);
    if (failed > 0) process.exit(1);
}

module.exports = { request, test, assert, summary, logRequest, logResponse };
