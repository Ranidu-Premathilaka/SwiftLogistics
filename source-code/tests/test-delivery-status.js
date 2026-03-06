/**
 * Delivery Status Integration Test
 *
 * Tests the GET /deliveries?orderId=xxx endpoint, which allows any authenticated
 * user (client or driver) to query the WMS delivery status of an order.
 *
 * Flow:
 *   1.  POST /auth/signup + login       — create a client user
 *   2.  WS  /notify                     — open WebSocket before any events fire
 *   3.  GET  /items                     — find an in-stock item
 *   4.  POST /order                     — create an order (seeds CMS)
 *   5.  WS  payment_intent_created      — confirm orderId
 *   6.  PATCH /order (order_confirmed)  — triggers WMS reservation + payment
 *   7.  WS  payment_completed           — confirms WMS deliveryStatus = ready_for_pickup
 *   8.  GET  /deliveries?orderId=xxx      — query delivery status
 *   9.  WS  delivery_status             — assert deliveryStatus = 'ready_for_pickup'
 *   10. GET  /deliveries?orderId=unknown  — query non-existent order
 *   11. WS  delivery_status             — assert error is present, deliveryStatus = null
 *
 * Requires the full stack to be running (./start.sh)
 *
 * Usage:
 *   node source-code/tests/test-delivery-status.js
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

const USERNAME = `delivery_status_test_${Date.now()}`;
const PASSWORD  = 'TestPass123!';

let accessToken    = null;
let selectedItem   = null;
let createdOrderId = null;

// ── Notification Collector ────────────────────────────────────────────────────

class NotificationCollector {
    constructor() {
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
                    console.log(`     ${c.gray}WS ←${c.reset} ${c.magenta}${event}${c.reset} ${c.gray}${JSON.stringify(msg.payload).slice(0, 120)}${c.reset}`);
                    this._deliver(msg);
                } catch { /* ignore parse errors */ }
            });
            this.ws.on('close', () =>
                console.log(`     ${c.gray}── WebSocket closed ──${c.reset}`)
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
            `Timeout (${ms}ms) waiting for WS event: ${eventName}`,
        );
    }

    // Wait for the next delivery_status event regardless of orderId.
    // Used when multiple delivery_status events may arrive out of order.
    waitForDeliveryStatus(orderId, ms = 20000) {
        return this._wait(
            msg => msg.payload?.event === 'delivery_status' && msg.payload?.orderId === orderId,
            ms,
            `Timeout (${ms}ms) waiting for delivery_status for orderId=${orderId}`,
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

const notifications = new NotificationCollector();

// ── Test Suite ────────────────────────────────────────────────────────────────

(async () => {
    console.log(`\n${c.bold}${c.blue}── Delivery Status Workflow Tests ────────────────────────${c.reset}`);
    console.log(`   ${c.gray}user:${c.reset} ${USERNAME}  ${c.gray}gateway:${c.reset} ${GATEWAY_HOST}:${GATEWAY_PORT}\n`);

    // ── 1. Auth setup ─────────────────────────────────────────────────────────

    await test('POST /auth/signup → 200 creates test user', async () => {
        const { status, body } = await request(
            'POST', '/auth/signup',
            { username: USERNAME, password: PASSWORD, role: 'client' },
            { 'x-request-id': `signup-${Date.now()}` },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('POST /auth/login → 200 returns accessToken', async () => {
        const { status, body } = await request(
            'POST', '/auth/login',
            { username: USERNAME, password: PASSWORD },
            { 'x-request-id': `login-${Date.now()}` },
        );
        assert(status === 200,                       `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string', 'Missing accessToken');
        accessToken = body.accessToken;
    });

    // ── 2. Open WebSocket ─────────────────────────────────────────────────────

    await test('WebSocket connects to /notify with JWT', async () => {
        await notifications.connect(accessToken);
    });

    // ── 3. Browse inventory ───────────────────────────────────────────────────

    await test('GET /items → queues request, WS delivers items_response', async () => {
        const { status } = await request(
            'GET', '/items/',
            null,
            { Authorization: `Bearer ${accessToken}` },
        );
        assert(status === 200, `Expected 200, got ${status}`);

        const msg = await notifications.waitFor('items_response', 10000);
        assert(Array.isArray(msg.payload.items), 'payload.items should be an array');
        assert(msg.payload.items.length > 0,     'Inventory should have at least one item');

        selectedItem = msg.payload.items.find(i => i.stock >= 1);
        assert(selectedItem, 'Need at least one item with stock ≥ 1');
        console.log(`     ${c.gray}selected:${c.reset} ${c.cyan}${selectedItem.itemId}${c.reset}  name=${c.yellow}${selectedItem.name}${c.reset}`);
    });

    // ── 4. Create order ───────────────────────────────────────────────────────

    await test('POST /order → 200 initiates order creation', async () => {
        const { status, body } = await request(
            'POST', '/order/',
            { itemList: [{ itemId: selectedItem.itemId, quantity: 1, price: selectedItem.price }] },
            {
                Authorization:  `Bearer ${accessToken}`,
                'x-request-id': `create-${Date.now()}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('WS: payment_intent_created confirms order in CMS', async () => {
        const msg = await notifications.waitFor('payment_intent_created', 20000);
        assert(typeof msg.payload.orderId === 'string', 'orderId missing');
        createdOrderId = msg.payload.orderId;
        console.log(`     ${c.gray}orderId:${c.reset} ${c.cyan}${createdOrderId}${c.reset}`);
    });

    // ── 5. Confirm order + await payment outcome ──────────────────────────────

    let paymentOutcome = null;

    await test('PATCH /order (order_confirmed) → 200', async () => {
        const paymentToken = `${createdOrderId}-token`;
        const { status, body } = await request(
            'PATCH', '/order/',
            { orderId: createdOrderId, status: 'order_confirmed', data: { paymentToken } },
            {
                Authorization:  `Bearer ${accessToken}`,
                'x-request-id': `confirm-${Date.now()}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('WS: payment_completed or payment_failed received', async () => {
        const msg = await notifications.waitFor('payment_completed', 30000).catch(async () => {
            // If payment_completed already passed, look in queue for payment_failed
            const failMsg = await notifications.waitFor('payment_failed', 5000).catch(() => null);
            return failMsg;
        });
        assert(msg !== null, 'Expected payment_completed or payment_failed notification');
        paymentOutcome = msg?.payload?.event;
        console.log(`     ${c.gray}outcome:${c.reset} ${c.yellow}${paymentOutcome}${c.reset}`);
    });

    // ── 6. Query delivery status for the paid order ───────────────────────────
    // After payment_completed, order-service publishes wms.delivery.update_status:ready_for_pickup.
    // A small wait ensures the async WMS update lands before we query it.

    if (paymentOutcome === 'payment_completed') {
        await new Promise(r => setTimeout(r, 1500));

        await test('GET /deliveries?orderId=xxx → 200 "Delivery status request initiated"', async () => {
            const { status, body } = await request(
                'GET', `/deliveries/?orderId=${createdOrderId}`,
                null,
                {
                    Authorization:  `Bearer ${accessToken}`,
                    'x-request-id': `status-${Date.now()}`,
                },
            );
            assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
            assert(
                typeof body === 'string' && body.toLowerCase().includes('initiated'),
                `Unexpected response: ${JSON.stringify(body)}`,
            );
        });

        await test('WS: delivery_status event received with deliveryStatus = ready_for_pickup', async () => {
            const msg = await notifications.waitForDeliveryStatus(createdOrderId, 20000);

            assert(msg.persist === 0,                           `Expected persist 0 (ephemeral), got '${msg.persist}'`);
            assert(msg.payload.orderId === createdOrderId,      `orderId mismatch: ${msg.payload.orderId}`);
            assert(msg.payload.deliveryStatus === 'ready_for_pickup',
                `Expected deliveryStatus='ready_for_pickup', got '${msg.payload.deliveryStatus}'`);
            assert(!msg.payload.error,                          `Unexpected error: ${msg.payload.error}`);

            console.log(`     ${c.green}${c.bold}✔ deliveryStatus = ${msg.payload.deliveryStatus}${c.reset}`);
        });
    } else {
        console.log(`     ${c.yellow}⚠ Payment was declined — skipping ready_for_pickup assertion${c.reset}`);
    }

    // ── 7. Query delivery status for an unknown orderId ───────────────────────
    // WMS has no reservation → should return null deliveryStatus with an error message.

    const unknownOrderId = `ORD-unknown-${Date.now()}`;

    await test('GET /deliveries?orderId=unknown → 200 "Delivery status request initiated"', async () => {
        const { status, body } = await request(
            'GET', `/deliveries/?orderId=${unknownOrderId}`,
            null,
            {
                Authorization:  `Bearer ${accessToken}`,
                'x-request-id': `status-unknown-${Date.now()}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('WS: delivery_status has null deliveryStatus + error for unknown orderId', async () => {
        const msg = await notifications.waitForDeliveryStatus(unknownOrderId, 20000);

        assert(msg.persist === 0,                                 `Expected persist 0 (ephemeral), got '${msg.persist}'`);
        assert(msg.payload.orderId === unknownOrderId,            `orderId mismatch: ${msg.payload.orderId}`);
        assert(msg.payload.deliveryStatus === null,               `Expected deliveryStatus=null, got '${msg.payload.deliveryStatus}'`);
        assert(typeof msg.payload.error === 'string',             'Expected an error message for unknown order');

        console.log(`     ${c.green}${c.bold}✔ error: ${msg.payload.error}${c.reset}`);
    });

    // ── 8. Role check — GET /deliveries must NOT require driver role ────────────
    // The client account used throughout this test already proves non-driver access.
    // Just confirm the 401 path works for unauthenticated requests.

    await test('GET /deliveries without token → 401', async () => {
        const { status } = await request(
            'GET', `/deliveries/?orderId=${createdOrderId}`,
            null,
            {},   // no Authorization header
        );
        assert(status === 401, `Expected 401, got ${status}`);
    });

    // ── Teardown ──────────────────────────────────────────────────────────────

    notifications.close();
    summary();
})();
