/**
 * SwiftLogistics — Full System Integration Test
 *
 * Single end-to-end workflow that exercises every user story in sequence
 * using one shared client and one shared driver across the entire run.
 *
 * Sequence:
 *   ── Phase 1: Auth ──────────────────────────────────────────────────────
 *    1.  Client signup + login  →  clientToken
 *    2.  Driver signup + login  →  driverToken
 *    3.  Both WebSockets open   →  client WS + driver WS
 *    4.  Auth error cases       →  duplicate 409, bad password 401, JWT guard
 *
 *   ── Phase 2: Browse Inventory ──────────────────────────────────────────
 *    5.  GET /items  →  WS items_response
 *
 *   ── Phase 3: Create Orders (seeds delivery workflow) ───────────────────
 *    6.  ×ORDER_COUNT  POST /order (with destination)
 *                   →  WS payment_intent_created
 *                   →  PATCH /order (order_confirmed)
 *                   →  WS payment_completed | payment_failed
 *
 *   ── Phase 4: View Orders ───────────────────────────────────────────────
 *    7.  GET /order  →  WS order_query_response (all own orders visible)
 *
 *   ── Phase 5: Query Delivery Status ─────────────────────────────────────
 *    8.  GET /deliveries?orderId=paid  →  WS delivery_status = ready_for_pickup
 *    9.  GET /deliveries?orderId=???   →  WS delivery_status = null + error
 *   10.  GET /deliveries (no token)   →  401
 *
 *   ── Phase 6: Assign Delivery Route ─────────────────────────────────────
 *   11. POST /deliveries (client role) →  403
 *   12. POST /deliveries count=1       →  WS driver_route (1 stop)
 *   13. POST /deliveries count=2       →  WS driver_route (2 stops)  [if available]
 *
 *   ── Phase 7: Complete / Reject Delivery ────────────────────────────────
 *   14. PATCH /deliveries (completed + signatureUrl)  →  WS delivery_status = delivered
 *   15. PATCH /deliveries (rejected, synthetic order) →  WS delivery_status = rejected
 *
 *   ── Phase 8: PATCH /deliveries — Validation Errors ─────────────────────
 *   16. client role         → 403
 *   17. no token            → 401
 *   18. missing orderId     → 400
 *   19. invalid status      → 400
 *   20. completed, no sig   → 400
 *
 * Usage:
 *   node source-code/tests/test-all.js
 *
 * Requires the full stack to be running (./start.sh)
 */

'use strict';

const WebSocket = require('ws');
const { request, test, assert, summary } = require('./helpers');

// ── Config ────────────────────────────────────────────────────────────────────

const GATEWAY_HOST = process.env.GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8081;

const c = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
    magenta: '\x1b[35m', gray: '\x1b[90m', blue: '\x1b[34m', red: '\x1b[31m',
};

const TS            = Date.now();
const CLIENT        = `all_client_${TS}`;
const DRIVER        = `all_driver_${TS}`;
const PASSWORD      = 'TestPass123!';
const ORDER_COUNT   = 3;
const SIGNATURE_URL = 'https://cdn.swiftlogistics.example/signatures/sig-all-test.jpg';

const ORDER_DESTINATIONS = Array.from({ length: ORDER_COUNT }, (_, i) =>
    `${10 + i} Logistics Ave, Zone ${(TS + i) % 99}`
);

// ── Shared state ──────────────────────────────────────────────────────────────

let clientToken       = null;
let driverToken       = null;
let selectedItems     = [];
let completedOrderIds = [];
let routeOrderId      = null;

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
                    const msg     = JSON.parse(raw.toString());
                    const event   = msg.payload?.event ?? '(no event)';
                    const persist = msg.persist === 0
                        ? `${c.gray}ephemeral${c.reset}`
                        : `${c.cyan}persisted${c.reset}`;
                    const extras  = Object.entries(msg.payload ?? {})
                        .filter(([k]) => k !== 'event')
                        .map(([k, v]) => `${c.gray}${k}=${c.reset}${c.yellow}${typeof v === 'object' ? JSON.stringify(v) : v}${c.reset}`)
                        .join('  ');
                    console.log(`     ${c.bold}${c.magenta}← WS [${this._label}]${c.reset}  ${c.bold}${c.cyan}${event}${c.reset}  [${persist}]${extras ? `  ${extras}` : ''}`);
                    this._deliver(msg);
                } catch {/* ignore parse errors */}
            });
            this.ws.on('close', () =>
                console.log(`     ${c.gray}── WS [${this._label}] closed ──${c.reset}`)
            );
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
        return this._wait(
            msg => msg.payload?.event === eventName,
            ms,
            `[${this._label}] timeout waiting for: ${eventName}`,
        );
    }

    waitForAny(events, ms = 25000) {
        const set = new Set(events);
        return this._wait(
            msg => set.has(msg.payload?.event),
            ms,
            `[${this._label}] timeout waiting for any of: ${events.join(' | ')}`,
        );
    }

    waitForDeliveryStatus(orderId, ms = 25000) {
        return this._wait(
            msg => msg.payload?.event === 'delivery_status' && msg.payload?.orderId === orderId,
            ms,
            `[${this._label}] timeout waiting for delivery_status orderId=${orderId}`,
        );
    }

    _wait(matchFn, ms, errorMsg) {
        const idx = this._queue.findIndex(matchFn);
        if (idx !== -1) return Promise.resolve(this._queue.splice(idx, 1)[0]);
        return new Promise((resolve, reject) => {
            const id    = Symbol();
            const timer = setTimeout(() => {
                this._waiters = this._waiters.filter(w => w.id !== id);
                reject(new Error(errorMsg));
            }, ms);
            this._waiters.push({ id, matches: matchFn, resolve, reject, timer });
        });
    }

    close() { if (this.ws) { this.ws.close(); this.ws = null; } }
}

const clientWS = new NotificationCollector('client');
const driverWS = new NotificationCollector('driver');

function section(title) {
    const bar = '─'.repeat(56);
    console.log(`\n${c.bold}${c.blue}  ┌${bar}┐${c.reset}`);
    console.log(`${c.bold}${c.blue}  │  ${title.padEnd(54)}│${c.reset}`);
    console.log(`${c.bold}${c.blue}  └${bar}┘${c.reset}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
    console.log(`\n${c.bold}${c.blue}  SwiftLogistics — Full System Integration Test${c.reset}`);
    console.log(`  ${c.gray}client: ${CLIENT}  driver: ${DRIVER}  gw: ${GATEWAY_HOST}:${GATEWAY_PORT}${c.reset}\n`);

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 1 — Auth
    // ═══════════════════════════════════════════════════════════════════════════

    section('Phase 1 — Auth');

    await test('POST /auth/signup → 200 creates client account', async () => {
        const { status, body } = await request(
            'POST', '/auth/signup',
            { username: CLIENT, password: PASSWORD, role: 'client' },
            { 'x-request-id': `signup-client-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('POST /auth/login → 200 returns clientToken', async () => {
        const { status, body } = await request(
            'POST', '/auth/login',
            { username: CLIENT, password: PASSWORD },
            { 'x-request-id': `login-client-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string', 'Missing accessToken');
        clientToken = body.accessToken;
    });

    await test('POST /auth/signup → 200 creates driver account', async () => {
        const { status, body } = await request(
            'POST', '/auth/signup',
            { username: DRIVER, password: PASSWORD, role: 'driver' },
            { 'x-request-id': `signup-driver-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('POST /auth/login → 200 returns driverToken', async () => {
        const { status, body } = await request(
            'POST', '/auth/login',
            { username: DRIVER, password: PASSWORD },
            { 'x-request-id': `login-driver-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string', 'Missing accessToken');
        driverToken = body.accessToken;
    });

    await test('Client WebSocket connects to /notify', async () => {
        await clientWS.connect(clientToken);
    });

    await test('Driver WebSocket connects to /notify', async () => {
        await driverWS.connect(driverToken);
    });

    await test('POST /auth/signup → 409 on duplicate username', async () => {
        const { status } = await request(
            'POST', '/auth/signup',
            { username: CLIENT, password: PASSWORD },
            { 'x-request-id': `signup-dup-${TS}` },
        );
        assert(status === 409, `Expected 409, got ${status}`);
    });

    await test('POST /auth/login → 401 on wrong password', async () => {
        const { status } = await request(
            'POST', '/auth/login',
            { username: CLIENT, password: 'wrongpassword' },
            { 'x-request-id': `login-bad-${TS}` },
        );
        assert(status === 401, `Expected 401, got ${status}`);
    });

    await test('Protected route without token → 401', async () => {
        const { status } = await request('GET', '/order/', null, {});
        assert(status === 401, `Expected 401, got ${status}`);
    });

    await test('Protected route with invalid token → 401', async () => {
        const { status } = await request('GET', '/order/', null, {
            Authorization: 'Bearer this.is.not.valid',
        });
        assert(status === 401, `Expected 401, got ${status}`);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 2 — Browse Inventory
    // ═══════════════════════════════════════════════════════════════════════════

    section('Phase 2 — Browse Inventory');

    await test('GET /items → 200 and WS delivers items_response', async () => {
        const { status } = await request(
            'GET', '/items/', null,
            { Authorization: `Bearer ${clientToken}` },
        );
        assert(status === 200, `Expected 200, got ${status}`);

        const msg = await clientWS.waitFor('items_response', 12000);
        assert(Array.isArray(msg.payload.items), 'payload.items should be an array');
        assert(msg.payload.items.length > 0, 'Inventory should have at least one item');

        msg.payload.items.forEach((item, i) => {
            assert(typeof item.itemId === 'string', `items[${i}].itemId missing`);
            assert(typeof item.stock  === 'number', `items[${i}].stock missing`);
            assert(typeof item.price  === 'number', `items[${i}].price missing`);
        });

        selectedItems = msg.payload.items
            .filter(i => i.stock >= 1)
            .slice(0, 1)
            .map(i => ({ itemId: i.itemId, quantity: 1, price: i.price }));

        assert(selectedItems.length > 0, 'Need at least one item in stock');
        console.log(`     ${c.gray}selected:${c.reset} ${c.cyan}${selectedItems[0].itemId}${c.reset}  price=${c.green}$${selectedItems[0].price}${c.reset}`);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 3 — Create Orders
    // ═══════════════════════════════════════════════════════════════════════════

    section(`Phase 3 — Create ${ORDER_COUNT} Orders`);

    for (let i = 0; i < ORDER_COUNT; i++) {
        const destination = ORDER_DESTINATIONS[i];
        const n           = i + 1;
        const createId    = `create-all-${TS}-${n}`;
        const confirmId   = `confirm-all-${TS}-${n}`;
        let   orderId     = null;

        await test(`POST /order #${n} (dest: ${destination}) → 200`, async () => {
            const { status, body } = await request(
                'POST', '/order/',
                { itemList: selectedItems, destination },
                { Authorization: `Bearer ${clientToken}`, 'x-request-id': createId },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        });

        await test(`WS payment_intent_created for order #${n}`, async () => {
            const msg = await clientWS.waitFor('payment_intent_created', 20000);
            assert(typeof msg.payload.orderId      === 'string', 'orderId missing');
            assert(typeof msg.payload.clientSecret === 'string', 'clientSecret missing');
            orderId = msg.payload.orderId;
            console.log(`     ${c.gray}orderId:${c.reset} ${c.cyan}${orderId}${c.reset}`);
        });

        await test(`PATCH /order #${n} (order_confirmed) → 200`, async () => {
            const { status, body } = await request(
                'PATCH', '/order/',
                { orderId, status: 'order_confirmed', data: { paymentToken: `${orderId}-token` } },
                { Authorization: `Bearer ${clientToken}`, 'x-request-id': confirmId },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        });

        await test(`WS payment outcome for order #${n}`, async () => {
            const msg = await clientWS.waitForAny(['payment_completed', 'payment_failed'], 35000);
            assert(msg.payload.orderId === orderId, `orderId mismatch: ${msg.payload.orderId}`);
            if (msg.payload.event === 'payment_completed') {
                completedOrderIds.push(orderId);
                console.log(`     ${c.green}${c.bold}✔ payment_completed${c.reset}  txn=${c.cyan}${msg.payload.transactionId}${c.reset}`);
            } else {
                console.log(`     ${c.yellow}⚠ payment_failed  reason=${msg.payload.reason}${c.reset}`);
            }
        });
    }

    console.log(`\n     ${c.gray}orders reaching payment_completed:${c.reset} ${c.cyan}${completedOrderIds.length}${c.reset} / ${ORDER_COUNT}`);

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 4 — View Orders
    // ═══════════════════════════════════════════════════════════════════════════

    section('Phase 4 — View Orders');

    await test('GET /order → 200 "Order query initiated"', async () => {
        const { status, body } = await request(
            'GET', '/order/', null,
            { Authorization: `Bearer ${clientToken}`, 'x-request-id': `get-orders-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body === 'string' && body.toLowerCase().includes('initiated'),
            `Unexpected response: ${JSON.stringify(body)}`);
    });

    await test('WS order_query_response contains our created orders', async () => {
        const msg = await clientWS.waitFor('order_query_response', 20000);
        assert(msg.persist === 0,                 'Expected ephemeral (persist 0)');
        assert(Array.isArray(msg.payload.orders), 'payload.orders should be an array');
        assert(msg.payload.orders.length > 0,     'Expected at least one order');

        msg.payload.orders.forEach((o, i) => {
            assert(typeof o.orderId  === 'string', `orders[${i}].orderId missing`);
            assert(typeof o.clientId === 'string', `orders[${i}].clientId missing`);
            assert(typeof o.status   === 'string', `orders[${i}].status missing`);
            assert(Array.isArray(o.itemList),       `orders[${i}].itemList missing`);
        });

        for (const id of completedOrderIds) {
            assert(msg.payload.orders.some(o => o.orderId === id),
                `Order ${id} missing from order_query_response`);
        }

        console.log(`     ${c.green}${c.bold}✔ ${msg.payload.orders.length} order(s) returned${c.reset}`);
        msg.payload.orders.forEach(o =>
            console.log(`       ${c.cyan}${o.orderId}${c.reset}  status=${c.yellow}${o.status}${c.reset}`)
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 5 — Query Delivery Status
    // ═══════════════════════════════════════════════════════════════════════════

    section('Phase 5 — Query Delivery Status');

    if (completedOrderIds.length > 0) {
        // Brief wait for order-service to publish the WMS ready_for_pickup update
        await new Promise(r => setTimeout(r, 1500));
        const paidOrderId = completedOrderIds[0];

        await test('GET /deliveries?orderId=paid → 200 "initiated"', async () => {
            const { status, body } = await request(
                'GET', `/deliveries/?orderId=${paidOrderId}`, null,
                { Authorization: `Bearer ${clientToken}`, 'x-request-id': `status-q-${TS}` },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
            assert(typeof body === 'string' && body.toLowerCase().includes('initiated'),
                `Unexpected response: ${JSON.stringify(body)}`);
        });

        await test('WS delivery_status = ready_for_pickup after payment', async () => {
            const msg = await clientWS.waitForDeliveryStatus(paidOrderId, 20000);
            assert(msg.persist === 0,                                'Expected ephemeral');
            assert(msg.payload.orderId === paidOrderId,             'orderId mismatch');
            assert(msg.payload.deliveryStatus === 'ready_for_pickup',
                `Expected ready_for_pickup, got '${msg.payload.deliveryStatus}'`);
            assert(!msg.payload.error, `Unexpected error: ${msg.payload.error}`);
            console.log(`     ${c.green}${c.bold}✔ deliveryStatus = ${msg.payload.deliveryStatus}${c.reset}`);
        });
    } else {
        console.log(`     ${c.yellow}⚠ All payments failed — skipping ready_for_pickup check${c.reset}`);
    }

    const unknownOrderId = `ORD-unknown-${TS}`;

    await test('GET /deliveries?orderId=unknown → 200 (WS delivers null + error)', async () => {
        const { status, body } = await request(
            'GET', `/deliveries/?orderId=${unknownOrderId}`, null,
            { Authorization: `Bearer ${clientToken}`, 'x-request-id': `status-unk-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('WS delivery_status = null + error for unknown order', async () => {
        const msg = await clientWS.waitForDeliveryStatus(unknownOrderId, 20000);
        assert(msg.persist === 0,                            'Expected ephemeral');
        assert(msg.payload.orderId === unknownOrderId,       'orderId mismatch');
        assert(msg.payload.deliveryStatus === null,          'Expected null deliveryStatus');
        assert(typeof msg.payload.error === 'string',        'Expected error string');
        console.log(`     ${c.green}${c.bold}✔ error: ${msg.payload.error}${c.reset}`);
    });

    await test('GET /deliveries without token → 401', async () => {
        const { status } = await request(
            'GET', `/deliveries/?orderId=${unknownOrderId}`, null, {},
        );
        assert(status === 401, `Expected 401, got ${status}`);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 6 — Assign Delivery Route
    // ═══════════════════════════════════════════════════════════════════════════

    section('Phase 6 — Assign Delivery Route');

    // Allow time for all pending_delivery status transitions to propagate
    // and for route-service to index locations from order.status_updated events
    await new Promise(r => setTimeout(r, 3000));

    await test('POST /deliveries (client role) → 403', async () => {
        const { status } = await request(
            'POST', '/deliveries/',
            { count: 1 },
            { Authorization: `Bearer ${clientToken}`, 'x-request-id': `del-403-${TS}` },
        );
        assert(status === 403, `Expected 403, got ${status}`);
    });

    if (completedOrderIds.length === 0) {
        console.log(`     ${c.yellow}⚠ No paid orders — skipping route assignment tests${c.reset}`);
    } else {
        await test('POST /deliveries (count=1) → 200 driver initiates delivery', async () => {
            const { status, body } = await request(
                'POST', '/deliveries/',
                { count: 1 },
                { Authorization: `Bearer ${driverToken}`, 'x-request-id': `del-1-${TS}` },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
            assert(typeof body === 'string' && body.toLowerCase().includes('initiated'),
                `Unexpected response: ${JSON.stringify(body)}`);
        });

        await test('WS (driver) driver_route received with 1 stop', async () => {
            const msg = await driverWS.waitFor('driver_route', 45000);
            assert(Array.isArray(msg.payload.route), 'route should be an array');
            assert(msg.payload.route.length === 1,   `Expected 1 stop, got ${msg.payload.route.length}`);
            routeOrderId = msg.payload.route[0].orderId;
            console.log(`     ${c.green}${c.bold}✔ driver_route (1 stop)${c.reset}`);
            console.log(`       ${c.cyan}1.${c.reset} orderId=${c.yellow}${routeOrderId}${c.reset}  loc=${c.gray}${msg.payload.route[0].location}${c.reset}`);
        });

        const remaining = completedOrderIds.length - 1;
        if (remaining >= 2) {
            await test('POST /deliveries (count=2) → 200 driver initiates multi-stop delivery', async () => {
                const { status, body } = await request(
                    'POST', '/deliveries/',
                    { count: 2 },
                    { Authorization: `Bearer ${driverToken}`, 'x-request-id': `del-2-${TS}` },
                );
                assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
            });

            await test('WS (driver) driver_route received with 2 stops', async () => {
                const msg = await driverWS.waitFor('driver_route', 45000);
                assert(Array.isArray(msg.payload.route), 'route should be an array');
                assert(msg.payload.route.length === 2,   `Expected 2 stops, got ${msg.payload.route.length}`);
                console.log(`     ${c.green}${c.bold}✔ driver_route (2 stops)${c.reset}`);
                msg.payload.route.forEach((s, i) =>
                    console.log(`       ${c.cyan}${i + 1}.${c.reset} orderId=${c.yellow}${s.orderId}${c.reset}  loc=${c.gray}${s.location}${c.reset}`)
                );
            });
        } else {
            console.log(`     ${c.yellow}⚠ Only ${remaining} order(s) remaining — skipping 2-stop test${c.reset}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 7 — Complete / Reject Delivery
    // ═══════════════════════════════════════════════════════════════════════════

    section('Phase 7 — Complete / Reject Delivery');

    const completeOrderId = routeOrderId ?? completedOrderIds[0];

    if (completeOrderId) {
        await test('PATCH /deliveries (completed + signatureUrl) → 200', async () => {
            const { status, body } = await request(
                'PATCH', '/deliveries/',
                { orderId: completeOrderId, status: 'completed', signatureUrl: SIGNATURE_URL },
                { Authorization: `Bearer ${driverToken}`, 'x-request-id': `complete-${TS}` },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
            assert(typeof body === 'string' && body.toLowerCase().includes('dispatched'),
                `Unexpected response: ${JSON.stringify(body)}`);
        });

        await test('WS (driver) delivery_status = delivered', async () => {
            const msg = await driverWS.waitForDeliveryStatus(completeOrderId, 20000);
            assert(msg.persist === 0,                       'Expected ephemeral');
            assert(msg.payload.orderId === completeOrderId, 'orderId mismatch');
            assert(msg.payload.deliveryStatus === 'delivered',
                `Expected delivered, got '${msg.payload.deliveryStatus}'`);
            console.log(`     ${c.green}${c.bold}✔ deliveryStatus = ${msg.payload.deliveryStatus}${c.reset}`);
        });
    } else {
        console.log(`     ${c.yellow}⚠ No paid order available — skipping completed-delivery test${c.reset}`);
    }

    const rejectOrderId = `ORD-reject-${TS}`;

    await test('PATCH /deliveries (rejected, no signatureUrl) → 200', async () => {
        const { status, body } = await request(
            'PATCH', '/deliveries/',
            { orderId: rejectOrderId, status: 'rejected' },
            { Authorization: `Bearer ${driverToken}`, 'x-request-id': `reject-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body === 'string' && body.toLowerCase().includes('dispatched'),
            `Unexpected response: ${JSON.stringify(body)}`);
    });

    await test('WS (driver) delivery_status = rejected (no signatureUrl)', async () => {
        const msg = await driverWS.waitForDeliveryStatus(rejectOrderId, 20000);
        assert(msg.persist === 0,                          'Expected ephemeral');
        assert(msg.payload.orderId === rejectOrderId,      'orderId mismatch');
        assert(msg.payload.deliveryStatus === 'rejected',
            `Expected rejected, got '${msg.payload.deliveryStatus}'`);
        assert(!msg.payload.signatureUrl, 'Did not expect signatureUrl for rejected delivery');
        console.log(`     ${c.green}${c.bold}✔ deliveryStatus = ${msg.payload.deliveryStatus}${c.reset}`);
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase 8 — PATCH /deliveries Validation Errors
    // ═══════════════════════════════════════════════════════════════════════════

    section('Phase 8 — PATCH /deliveries Validation Errors');

    await test('PATCH /deliveries (client role) → 403', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { orderId: 'any-order', status: 'completed', signatureUrl: SIGNATURE_URL },
            { Authorization: `Bearer ${clientToken}`, 'x-request-id': `val-role-${TS}` },
        );
        assert(status === 403, `Expected 403, got ${status}`);
    });

    await test('PATCH /deliveries without token → 401', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { orderId: 'any-order', status: 'completed', signatureUrl: SIGNATURE_URL },
            {},
        );
        assert(status === 401, `Expected 401, got ${status}`);
    });

    await test('PATCH /deliveries missing orderId → 400', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { status: 'completed', signatureUrl: SIGNATURE_URL },
            { Authorization: `Bearer ${driverToken}`, 'x-request-id': `val-noid-${TS}` },
        );
        assert(status === 400, `Expected 400, got ${status}`);
    });

    await test('PATCH /deliveries invalid status → 400', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { orderId: 'any-order', status: 'shipped', signatureUrl: SIGNATURE_URL },
            { Authorization: `Bearer ${driverToken}`, 'x-request-id': `val-badst-${TS}` },
        );
        assert(status === 400, `Expected 400, got ${status}`);
    });

    await test('PATCH /deliveries completed without signatureUrl → 400', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { orderId: 'any-order', status: 'completed' },
            { Authorization: `Bearer ${driverToken}`, 'x-request-id': `val-nosig-${TS}` },
        );
        assert(status === 400, `Expected 400, got ${status}`);
    });

    // ── Teardown ──────────────────────────────────────────────────────────────

    clientWS.close();
    driverWS.close();
    summary();
})();

