/**
 * Delivery Workflow Integration Tests
 *
 * Tests the end-to-end "driver gets assigned orders for delivery" story:
 *
 *   (Setup)    Client creates + pays for multiple orders with destination addresses.
 *              This seeds pending_delivery orders that the driver can claim.
 *
 *   1.  POST /auth/signup         — create driver account
 *   2.  POST /auth/login          — log in driver (get JWT)
 *   3.  POST /auth/signup         — create client account
 *   4.  POST /auth/login          — log in client
 *   5.  WS  /notify               — driver & client connect to listen for notifications
 *   6.  GET  /items               — client browses inventory
 *   7–10. (×3) POST /order → WS payment_intent_created → PATCH /order → WS payment_completed
 *   11. POST /deliveries (count=1) — driver requests 1 package for delivery
 *   12. WS   notify (driver)       — driver_route with 1 stop
 *   13. POST /deliveries (count=2) — driver requests 2 packages for delivery
 *   14. WS   notify (driver)       — driver_route with 2 stops
 *
 * Requires the full stack to be running (./start.sh)
 *
 * Usage:
 *   node source-code/tests/test-delivery-workflow.js
 */

const WebSocket = require('ws');
const { request, test, assert, summary } = require('./helpers');

const GATEWAY_HOST = process.env.GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8081;

// ── ANSI colours ──────────────────────────────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
    magenta: '\x1b[35m', gray: '\x1b[90m', blue: '\x1b[34m', red: '\x1b[31m',
};

const TS = Date.now();
const DRIVER_USERNAME   = `driver_${TS}`;
const CLIENT_USERNAME   = `client_${TS}`;
const PASSWORD          = 'TestPass123!';

const ORDER_COUNT       = 3;  // number of orders to create as delivery seeds
const ORDER_DESTINATIONS = Array.from({ length: ORDER_COUNT }, (_, i) =>
    `${10 + i} Warehouse Ave, Sector ${(TS + i) % 99}`
);

let clientToken     = null;
let driverToken     = null;
let selectedItems   = [];
let completedOrderIds = [];  // order IDs that reached pending_delivery

// ── Notification Collector ────────────────────────────────────────────────────

class NotificationCollector {
    constructor(label) {
        this._label   = label;
        this._queue   = [];
        this._waiters = [];
        this.ws       = null;
    }

    connect(token) {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`ws://${GATEWAY_HOST}:${GATEWAY_PORT}/notify`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            this.ws.once('open',  resolve);
            this.ws.once('error', reject);
            this.ws.on('message', (raw) => {
                try {
                    const msg   = JSON.parse(raw.toString());
                    const event = msg.payload?.event ?? '(no event)';
                    console.log(`     ${c.bold}${c.magenta}← WS [${this._label}]${c.reset}  ${c.bold}${c.cyan}${event}${c.reset}`);
                    this._deliver(msg);
                } catch {/* ignore parse errors */}
            });
            this.ws.on('close', () => {
                console.log(`     ${c.gray}── WS [${this._label}] closed ──${c.reset}`);
            });
        });
    }

    _deliver(msg) {
        const idx = this._waiters.findIndex(w => w.matches(msg));
        if (idx !== -1) {
            const [waiter] = this._waiters.splice(idx, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
        } else {
            this._queue.push(msg);
        }
    }

    waitFor(eventName, ms = 25000) {
        const existing = this._queue.findIndex(m => m.payload?.event === eventName);
        if (existing !== -1) return Promise.resolve(this._queue.splice(existing, 1)[0]);
        return new Promise((resolve, reject) => {
            const id    = Symbol();
            const timer = setTimeout(() => {
                this._waiters = this._waiters.filter(w => w.id !== id);
                reject(new Error(`[${this._label}] Timeout (${ms}ms) waiting for WS event: ${eventName}`));
            }, ms);
            this._waiters.push({ id, matches: m => m.payload?.event === eventName, resolve, reject, timer });
        });
    }

    waitForAny(eventNames, ms = 25000) {
        const set = new Set(eventNames);
        const existing = this._queue.findIndex(m => set.has(m.payload?.event));
        if (existing !== -1) return Promise.resolve(this._queue.splice(existing, 1)[0]);
        return new Promise((resolve, reject) => {
            const id    = Symbol();
            const timer = setTimeout(() => {
                this._waiters = this._waiters.filter(w => w.id !== id);
                reject(new Error(`[${this._label}] Timeout (${ms}ms) waiting for events: ${eventNames.join(' | ')}`));
            }, ms);
            this._waiters.push({ id, matches: m => set.has(m.payload?.event), resolve, reject, timer });
        });
    }

    close() { if (this.ws) { this.ws.close(); this.ws = null; } }
}

const clientNotify = new NotificationCollector('client');
const driverNotify = new NotificationCollector('driver');

// ── Test Suite ────────────────────────────────────────────────────────────────

(async () => {
    console.log(`\n${c.bold}${c.blue}── Delivery Workflow Tests ───────────────────────────────${c.reset}`);
    console.log(`   ${c.gray}driver:${c.reset}  ${DRIVER_USERNAME}`);
    console.log(`   ${c.gray}client:${c.reset}  ${CLIENT_USERNAME}`);
    console.log(`   ${c.gray}gateway:${c.reset} ${GATEWAY_HOST}:${GATEWAY_PORT}\n`);

    // ── 1. Create driver account ───────────────────────────────────────────

    await test('POST /auth/signup → 200 creates driver account', async () => {
        const { status, body } = await request(
            'POST', '/auth/signup',
            { username: DRIVER_USERNAME, password: PASSWORD, role: 'driver' },
            { 'x-request-id': `signup-driver-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    // ── 2. Driver login ────────────────────────────────────────────────────

    await test('POST /auth/login → 200 returns driver accessToken', async () => {
        const { status, body } = await request(
            'POST', '/auth/login',
            { username: DRIVER_USERNAME, password: PASSWORD },
            { 'x-request-id': `login-driver-${TS}` },
        );
        assert(status === 200,                         `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string',   'Missing accessToken');
        driverToken = body.accessToken;
    });

    // ── 3. Create client account ───────────────────────────────────────────

    await test('POST /auth/signup → 200 creates client account', async () => {
        const { status, body } = await request(
            'POST', '/auth/signup',
            { username: CLIENT_USERNAME, password: PASSWORD, role: 'client' },
            { 'x-request-id': `signup-client-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    // ── 4. Client login ────────────────────────────────────────────────────

    await test('POST /auth/login → 200 returns client accessToken', async () => {
        const { status, body } = await request(
            'POST', '/auth/login',
            { username: CLIENT_USERNAME, password: PASSWORD },
            { 'x-request-id': `login-client-${TS}` },
        );
        assert(status === 200,                         `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string',   'Missing accessToken');
        clientToken = body.accessToken;
    });

    // ── 5. Connect WebSockets ──────────────────────────────────────────────

    await test('Driver and client WebSockets connect to /notify', async () => {
        await driverNotify.connect(driverToken);
        await clientNotify.connect(clientToken);
    });

    // ── 6. Client browses inventory ────────────────────────────────────────

    await test('GET /items → client receives items_response via WS', async () => {
        const { status } = await request(
            'GET', '/items/',
            null,
            { Authorization: `Bearer ${clientToken}` },
        );
        assert(status === 200, `Expected 200, got ${status}`);

        const msg = await clientNotify.waitFor('items_response', 12000);
        assert(Array.isArray(msg.payload.items), 'payload.items should be an array');
        assert(msg.payload.items.length > 0,     'Inventory should have items');

        selectedItems = msg.payload.items
            .filter(i => i.stock >= 1)
            .slice(0, 1)
            .map(i => ({ itemId: i.itemId, quantity: 1, price: i.price }));

        assert(selectedItems.length > 0, 'Need at least one item in stock');
    });

    // ── 7–10. Create, confirm, and pay for ORDER_COUNT orders ──────────────
    //
    // Each iteration:
    //   POST /order (with destination) → WS payment_intent_created
    //   → PATCH /order (order_confirmed) → WS payment_completed / payment_failed
    //
    // Orders that complete payment are added to completedOrderIds.

    for (let i = 0; i < ORDER_COUNT; i++) {
        const destination = ORDER_DESTINATIONS[i];
        const orderNum    = i + 1;
        const reqId       = `create-${TS}-${orderNum}`;
        const confirmId   = `confirm-${TS}-${orderNum}`;

        let orderId      = null;
        let clientSecret = null;
        let paymentToken = null;

        await test(`POST /order #${orderNum} (destination: ${destination}) → 200`, async () => {
            const { status, body } = await request(
                'POST', '/order/',
                { itemList: selectedItems, destination },
                {
                    Authorization:  `Bearer ${clientToken}`,
                    'x-request-id': reqId,
                },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
            assert(typeof body === 'string' && body.toLowerCase().includes('initiated'),
                   `Unexpected response: ${JSON.stringify(body)}`);
            console.log(`     ${c.gray}destination:${c.reset} ${c.yellow}${destination}${c.reset}`);
        });

        await test(`WS (client): payment_intent_created for order #${orderNum}`, async () => {
            const msg = await clientNotify.waitFor('payment_intent_created', 20000);
            assert(typeof msg.payload.clientSecret === 'string', 'clientSecret missing');
            clientSecret = msg.payload.clientSecret;
            orderId      = msg.payload.orderId;
            paymentToken = clientSecret + '-token';
            console.log(`     ${c.gray}orderId:${c.reset}      ${c.cyan}${orderId}${c.reset}`);
            console.log(`     ${c.gray}clientSecret:${c.reset} ${c.yellow}${clientSecret}${c.reset}`);
        });

        await test(`PATCH /order #${orderNum} (order_confirmed) → 200`, async () => {
            const { status, body } = await request(
                'PATCH', '/order/',
                { orderId, status: 'order_confirmed', data: { paymentToken } },
                {
                    Authorization:  `Bearer ${clientToken}`,
                    'x-request-id': confirmId,
                },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        });

        await test(`WS (client): payment_completed for order #${orderNum}`, async () => {
            const msg = await clientNotify.waitForAny(['payment_completed', 'payment_failed'], 35000);
            assert(msg.payload.orderId === orderId, `orderId mismatch: ${msg.payload.orderId}`);

            if (msg.payload.event === 'payment_completed') {
                assert(typeof msg.payload.transactionId === 'string', 'transactionId missing');
                console.log(`     ${c.green}${c.bold}✔ payment succeeded${c.reset}  txn=${c.cyan}${msg.payload.transactionId}${c.reset}`);
                completedOrderIds.push(orderId);
            } else {
                console.log(`     ${c.yellow}⚠ payment failed (${msg.payload.reason}) — order #${orderNum} will not be available for delivery${c.reset}`);
            }
        });
    }

    // Give the system time to process status transitions to pending_delivery
    // and for the route-service to index the locations via order.status_updated.
    await new Promise(r => setTimeout(r, 3000));

    // Ensure at least one order made it to pending_delivery
    if (completedOrderIds.length === 0) {
        console.log(`     ${c.yellow}⚠ All ${ORDER_COUNT} payments failed — skipping delivery assertions${c.reset}`);
        clientNotify.close();
        driverNotify.close();
        summary();
        return;
    }
    console.log(`\n     ${c.gray}pending_delivery orders:${c.reset} ${c.cyan}${completedOrderIds.length}${c.reset} of ${ORDER_COUNT}\n`);

    // ── 11. Driver requests delivery (count=1) ─────────────────────────────

    await test('POST /deliveries → 403 if called with client token', async () => {
        const { status } = await request(
            'POST', '/deliveries/',
            { count: 1 },
            {
                Authorization:  `Bearer ${clientToken}`,
                'x-request-id': `del-client-${TS}`,
            },
        );
        assert(status === 403, `Expected 403, got ${status}`);
    });

    await test('POST /deliveries (count=1) → 200 driver initiates single delivery', async () => {
        const { status, body } = await request(
            'POST', '/deliveries/',
            { count: 1 },
            {
                Authorization:  `Bearer ${driverToken}`,
                'x-request-id': `del-single-${TS}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body === 'string' && body.toLowerCase().includes('initiated'),
               `Unexpected response: ${JSON.stringify(body)}`);
    });

    // ── 12. Driver receives route notification with 1 stop ────────────────

    await test('WS (driver): driver_route received with 1 stop', async () => {
        const msg = await driverNotify.waitFor('driver_route', 40000);

        assert(Array.isArray(msg.payload.route), 'route should be an array');
        assert(msg.payload.route.length === 1,   `Expected exactly 1 stop, got ${msg.payload.route.length}`);

        console.log(`     ${c.green}${c.bold}✔ driver_route received (1 stop)!${c.reset}`);
        msg.payload.route.forEach((stop, i) =>
            console.log(`       ${c.cyan}${i + 1}.${c.reset} orderId=${c.yellow}${stop.orderId}${c.reset}  location=${c.yellow}${stop.location}${c.reset}`)
        );
    });

    // ── 13. Driver requests delivery (count=2) ─────────────────────────────
    //
    // At this point there should still be (completedOrderIds.length - 1) orders
    // in pending_delivery. If ≥ 2 remain we can test multi-stop delivery.

    const remainingOrders = completedOrderIds.length - 1;
    const multiCount = Math.min(2, remainingOrders);

    if (multiCount >= 2) {
        await test(`POST /deliveries (count=${multiCount}) → 200 driver initiates multi-stop delivery`, async () => {
            const { status, body } = await request(
                'POST', '/deliveries/',
                { count: multiCount },
                {
                    Authorization:  `Bearer ${driverToken}`,
                    'x-request-id': `del-multi-${TS}`,
                },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
            assert(typeof body === 'string' && body.toLowerCase().includes('initiated'),
                   `Unexpected response: ${JSON.stringify(body)}`);
        });

        // ── 14. Driver receives route notification with multiple stops ─────

        await test(`WS (driver): driver_route received with ${multiCount} stops`, async () => {
            const msg = await driverNotify.waitFor('driver_route', 40000);

            assert(Array.isArray(msg.payload.route), 'route should be an array');
            assert(msg.payload.route.length === multiCount,
                   `Expected ${multiCount} stops, got ${msg.payload.route.length}`);

            console.log(`     ${c.green}${c.bold}✔ driver_route received (${msg.payload.route.length} stops)!${c.reset}`);
            msg.payload.route.forEach((stop, i) =>
                console.log(`       ${c.cyan}${i + 1}.${c.reset} orderId=${c.yellow}${stop.orderId}${c.reset}  location=${c.yellow}${stop.location}${c.reset}`)
            );
        });
    } else {
        console.log(`     ${c.yellow}⚠ Only ${remainingOrders} order(s) remain — skipping multi-stop delivery test${c.reset}`);
    }

    // ── Teardown ───────────────────────────────────────────────────────────

    clientNotify.close();
    driverNotify.close();
    summary();
})();
