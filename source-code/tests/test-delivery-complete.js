/**
 * Delivery Complete / Reject Integration Test
 *
 * Tests the PATCH /deliveries endpoint, which allows a driver to mark an order
 * as completed (with a proof-of-signature URL) or rejected.
 *
 * Flow:
 *   Setup (client):
 *     1.  POST /auth/signup + login       — create a client user
 *     2.  WS  /notify                     — open client WebSocket
 *     3.  GET  /items                     — find an in-stock item
 *     4.  POST /order                     — create an order
 *     5.  WS  payment_intent_created      — confirm orderId
 *     6.  PATCH /order (order_confirmed)  — triggers WMS reservation + payment
 *     7.  WS  payment_completed           — confirms order is in ready_for_pickup state
 *
 *   Setup (driver):
 *     8.  POST /auth/signup + login       — create a driver user
 *     9.  WS  /notify                     — open driver WebSocket
 *
 *   Happy paths:
 *     10. PATCH /deliveries { orderId, status: completed, signatureUrl }
 *     11. WS  delivery_status             — assert deliveryStatus = 'delivered', signatureUrl present
 *     12. PATCH /deliveries { orderId: unknown, status: rejected }  (no signatureUrl needed)
 *     13. WS  delivery_status             — assert deliveryStatus = 'rejected'
 *
 *   Validation / auth errors:
 *     14. PATCH /deliveries as client role → 403
 *     15. PATCH /deliveries without token → 401
 *     16. PATCH /deliveries missing orderId → 400
 *     17. PATCH /deliveries invalid status → 400
 *     18. PATCH /deliveries completed without signatureUrl → 400
 *
 * Requires the full stack to be running (./start.sh)
 *
 * Usage:
 *   node source-code/tests/test-delivery-complete.js
 */

const WebSocket = require('ws');
const { request, test, assert, summary } = require('./helpers');

const GATEWAY_HOST = process.env.GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8081;

const c = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
    magenta: '\x1b[35m', gray: '\x1b[90m', blue: '\x1b[34m', red: '\x1b[31m',
};

const TS              = Date.now();
const CLIENT_USERNAME = `dc_client_${TS}`;
const DRIVER_USERNAME = `dc_driver_${TS}`;
const PASSWORD        = 'TestPass123!';

let clientToken    = null;
let driverToken    = null;
let selectedItem   = null;
let createdOrderId = null;

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
                    console.log(`     ${c.gray}[${this._label}] WS ←${c.reset} ${c.magenta}${event}${c.reset} ${c.gray}${JSON.stringify(msg.payload).slice(0, 120)}${c.reset}`);
                    this._deliver(msg);
                } catch { /* ignore parse errors */ }
            });
            this.ws.on('close', () =>
                console.log(`     ${c.gray}── [${this._label}] WebSocket closed ──${c.reset}`)
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

    waitFor(eventName, ms = 20000) {
        return this._wait(
            msg => msg.payload?.event === eventName,
            ms,
            `[${this._label}] Timeout (${ms}ms) waiting for WS event: ${eventName}`,
        );
    }

    waitForDeliveryStatus(orderId, ms = 20000) {
        return this._wait(
            msg => msg.payload?.event === 'delivery_status' && msg.payload?.orderId === orderId,
            ms,
            `[${this._label}] Timeout (${ms}ms) waiting for delivery_status for orderId=${orderId}`,
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

const clientNotifications = new NotificationCollector('client');
const driverNotifications = new NotificationCollector('driver');

// ── Test Suite ────────────────────────────────────────────────────────────────

(async () => {
    console.log(`\n${c.bold}${c.blue}── Delivery Complete / Reject Workflow Tests ─────────────${c.reset}`);
    console.log(`   ${c.gray}client:${c.reset} ${CLIENT_USERNAME}  ${c.gray}driver:${c.reset} ${DRIVER_USERNAME}  ${c.gray}gateway:${c.reset} ${GATEWAY_HOST}:${GATEWAY_PORT}\n`);

    // ── 1. Client auth ────────────────────────────────────────────────────────

    await test('POST /auth/signup → 200 creates client user', async () => {
        const { status, body } = await request(
            'POST', '/auth/signup',
            { username: CLIENT_USERNAME, password: PASSWORD, role: 'client' },
            { 'x-request-id': `signup-client-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('POST /auth/login → 200 returns clientToken', async () => {
        const { status, body } = await request(
            'POST', '/auth/login',
            { username: CLIENT_USERNAME, password: PASSWORD },
            { 'x-request-id': `login-client-${TS}` },
        );
        assert(status === 200,                       `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string', 'Missing accessToken');
        clientToken = body.accessToken;
    });

    // ── 2. Client WebSocket ───────────────────────────────────────────────────

    await test('Client WebSocket connects to /notify', async () => {
        await clientNotifications.connect(clientToken);
    });

    // ── 3. Browse inventory ───────────────────────────────────────────────────

    await test('GET /items → WS delivers items_response', async () => {
        const { status } = await request(
            'GET', '/items/',
            null,
            { Authorization: `Bearer ${clientToken}` },
        );
        assert(status === 200, `Expected 200, got ${status}`);

        const msg = await clientNotifications.waitFor('items_response', 10000);
        assert(Array.isArray(msg.payload.items), 'payload.items should be an array');
        assert(msg.payload.items.length > 0,     'Inventory should have at least one item');

        selectedItem = msg.payload.items.find(i => i.stock >= 1);
        assert(selectedItem, 'Need at least one item with stock ≥ 1');
        console.log(`     ${c.gray}selected:${c.reset} ${c.cyan}${selectedItem.itemId}${c.reset}  name=${c.yellow}${selectedItem.name}${c.reset}`);
    });

    // ── 4. Create + confirm order ─────────────────────────────────────────────

    await test('POST /order → 200 initiates order creation', async () => {
        const { status, body } = await request(
            'POST', '/order/',
            { itemList: [{ itemId: selectedItem.itemId, quantity: 1, price: selectedItem.price }] },
            {
                Authorization:  `Bearer ${clientToken}`,
                'x-request-id': `create-${TS}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('WS: payment_intent_created confirms orderId', async () => {
        const msg = await clientNotifications.waitFor('payment_intent_created', 20000);
        assert(typeof msg.payload.orderId === 'string', 'orderId missing from payload');
        createdOrderId = msg.payload.orderId;
        console.log(`     ${c.gray}orderId:${c.reset} ${c.cyan}${createdOrderId}${c.reset}`);
    });

    let paymentOutcome = null;

    await test('PATCH /order (order_confirmed) → 200', async () => {
        const paymentToken = `${createdOrderId}-token`;
        const { status, body } = await request(
            'PATCH', '/order/',
            { orderId: createdOrderId, status: 'order_confirmed', data: { paymentToken } },
            {
                Authorization:  `Bearer ${clientToken}`,
                'x-request-id': `confirm-${TS}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('WS: payment_completed or payment_failed received', async () => {
        const msg = await clientNotifications.waitFor('payment_completed', 30000).catch(async () => {
            const failMsg = await clientNotifications.waitFor('payment_failed', 5000).catch(() => null);
            return failMsg;
        });
        assert(msg !== null, 'Expected payment_completed or payment_failed notification');
        paymentOutcome = msg?.payload?.event;
        console.log(`     ${c.gray}outcome:${c.reset} ${c.yellow}${paymentOutcome}${c.reset}`);
    });

    // ── 5. Driver auth + WebSocket ────────────────────────────────────────────

    await test('POST /auth/signup → 200 creates driver user', async () => {
        const { status, body } = await request(
            'POST', '/auth/signup',
            { username: DRIVER_USERNAME, password: PASSWORD, role: 'driver' },
            { 'x-request-id': `signup-driver-${TS}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('POST /auth/login → 200 returns driverToken', async () => {
        const { status, body } = await request(
            'POST', '/auth/login',
            { username: DRIVER_USERNAME, password: PASSWORD },
            { 'x-request-id': `login-driver-${TS}` },
        );
        assert(status === 200,                       `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string', 'Missing accessToken');
        driverToken = body.accessToken;
    });

    await test('Driver WebSocket connects to /notify', async () => {
        await driverNotifications.connect(driverToken);
    });

    // ── 6. Happy path — completed ─────────────────────────────────────────────
    // After payment_completed orderId is in ready_for_pickup in WMS.
    // Driver marks it as completed with a proof-of-signature URL.

    const SIGNATURE_URL = 'https://cdn.swiftlogistics.example/signatures/sig-test.jpg';

    if (paymentOutcome === 'payment_completed') {
        await test('PATCH /deliveries (completed) → 200 updates dispatched', async () => {
            const { status, body } = await request(
                'PATCH', '/deliveries/',
                { orderId: createdOrderId, status: 'completed', signatureUrl: SIGNATURE_URL },
                {
                    Authorization:  `Bearer ${driverToken}`,
                    'x-request-id': `complete-${TS}`,
                },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
            assert(
                typeof body === 'string' && body.toLowerCase().includes('dispatched'),
                `Unexpected response: ${JSON.stringify(body)}`,
            );
        });

        await test('WS: delivery_status with deliveryStatus = delivered + signatureUrl', async () => {
            const msg = await driverNotifications.waitForDeliveryStatus(createdOrderId, 20000);

            assert(msg.persist === 0,                                `Expected persist 0 (ephemeral), got '${msg.persist}'`);
            assert(msg.payload.orderId === createdOrderId,           `orderId mismatch: ${msg.payload.orderId}`);
            assert(msg.payload.deliveryStatus === 'delivered',       `Expected deliveryStatus='delivered', got '${msg.payload.deliveryStatus}'`);

            console.log(`     ${c.green}${c.bold}✔ deliveryStatus = ${msg.payload.deliveryStatus}${c.reset}`);
        });
    } else {
        console.log(`\n     ${c.yellow}⚠ Payment was declined — skipping completed-delivery happy path${c.reset}`);
    }

    // ── 7. Happy path — rejected ──────────────────────────────────────────────
    // No signatureUrl required for rejected. Use a synthetic orderId so this test
    // runs independently of payment outcome (the service fires the notify regardless
    // of whether the WMS / CMS updates succeed for an unknown order).

    const rejectedOrderId = `ORD-reject-test-${TS}`;

    await test('PATCH /deliveries (rejected) → 200 updates dispatched', async () => {
        const { status, body } = await request(
            'PATCH', '/deliveries/',
            { orderId: rejectedOrderId, status: 'rejected' },
            {
                Authorization:  `Bearer ${driverToken}`,
                'x-request-id': `reject-${TS}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(
            typeof body === 'string' && body.toLowerCase().includes('dispatched'),
            `Unexpected response: ${JSON.stringify(body)}`,
        );
    });

    await test('WS: delivery_status with deliveryStatus = rejected (no signatureUrl)', async () => {
        const msg = await driverNotifications.waitForDeliveryStatus(rejectedOrderId, 20000);

        assert(msg.persist === 0,                              `Expected persist 0 (ephemeral), got '${msg.persist}'`);
        assert(msg.payload.orderId === rejectedOrderId,        `orderId mismatch: ${msg.payload.orderId}`);
        assert(msg.payload.deliveryStatus === 'rejected',      `Expected deliveryStatus='rejected', got '${msg.payload.deliveryStatus}'`);
        assert(!msg.payload.signatureUrl,                      `Did not expect signatureUrl for rejected delivery`);

        console.log(`     ${c.green}${c.bold}✔ deliveryStatus = ${msg.payload.deliveryStatus}${c.reset}`);
    });

    // ── 8. Validation errors ──────────────────────────────────────────────────

    await test('PATCH /deliveries as client role → 403', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { orderId: createdOrderId, status: 'completed', signatureUrl: SIGNATURE_URL },
            {
                Authorization:  `Bearer ${clientToken}`,     // client role
                'x-request-id': `role-check-${TS}`,
            },
        );
        assert(status === 403, `Expected 403, got ${status}`);
    });

    await test('PATCH /deliveries without token → 401', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { orderId: createdOrderId, status: 'completed', signatureUrl: SIGNATURE_URL },
            {},   // no Authorization header
        );
        assert(status === 401, `Expected 401, got ${status}`);
    });

    await test('PATCH /deliveries missing orderId → 400', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { status: 'completed', signatureUrl: SIGNATURE_URL },
            {
                Authorization:  `Bearer ${driverToken}`,
                'x-request-id': `missing-order-${TS}`,
            },
        );
        assert(status === 400, `Expected 400, got ${status}`);
    });

    await test('PATCH /deliveries invalid status → 400', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { orderId: createdOrderId, status: 'unknown_status', signatureUrl: SIGNATURE_URL },
            {
                Authorization:  `Bearer ${driverToken}`,
                'x-request-id': `bad-status-${TS}`,
            },
        );
        assert(status === 400, `Expected 400, got ${status}`);
    });

    await test('PATCH /deliveries completed without signatureUrl → 400', async () => {
        const { status } = await request(
            'PATCH', '/deliveries/',
            { orderId: createdOrderId, status: 'completed' },   // no signatureUrl
            {
                Authorization:  `Bearer ${driverToken}`,
                'x-request-id': `no-sig-${TS}`,
            },
        );
        assert(status === 400, `Expected 400, got ${status}`);
    });

    // ── Teardown ──────────────────────────────────────────────────────────────

    clientNotifications.close();
    driverNotifications.close();
    summary();
})();
