/**
 * Order Workflow Integration Tests
 *
 * Tests the full end-to-end flow:
 *   GET  /items          — browse warehouse inventory
 *   POST /order          — create order (triggers payment-intent chain)
 *   WS   notify          — receive payment_intent_created with clientSecret
 *   PATCH /order         — confirm order with paymentToken
 *   WS   notify          — receive payment_completed | payment_failed
 *
 * Requires the full stack to be running (./start.sh)
 *
 * Usage:
 *   node source-code/tests/test-order-workflow.js
 */

const WebSocket = require('ws');
const { request, test, assert, summary } = require('./helpers');

const GATEWAY_HOST = process.env.GATEWAY_HOST || 'localhost';
const GATEWAY_PORT = process.env.GATEWAY_PORT || 8081;

// ── ANSI colours (local copy — helpers doesn't export them) ───────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m',
    green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
    magenta: '\x1b[35m', gray: '\x1b[90m', blue: '\x1b[34m', red: '\x1b[31m',
};

// Unique user per run to avoid state collisions
const USERNAME = `order_test_${Date.now()}`;
const PASSWORD  = 'TestPass123!';

let accessToken    = null;
let selectedItems  = [];   // items chosen from GET /items
let paymentRequestId = null; // x-request-id for the initial POST /order (for tracing/logging)
let orderId        = null; // generated in test, sent in PATCH /order, appears in notifications
let clientSecret   = null; // returned by payment_intent_created notification
let paymentToken    = null; // sent to PATCH /order to confirm the order

// ── Notification Collector ─────────────────────────────────────────────────
// Opens a WebSocket to /notify and collects incoming messages.
// waitFor / waitForAny return promises that resolve when a matching event arrives.

class NotificationCollector {
    constructor() {
        this._queue   = []; // messages that arrived before any waiter was registered
        this._waiters = []; // { id, matches, resolve, reject, timer }
        this.ws       = null;
    }

    connect(token) {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`ws://${GATEWAY_HOST}:${GATEWAY_PORT}/notify`, {
                headers: { Authorization: `Bearer ${token}` },
            });

            this.ws.once('open',    resolve);
            this.ws.once('error',   reject);

            this.ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    const event   = msg.payload?.event ?? '(no event)';
                    const persist = msg.persist === 0 ? `${c.gray}ephemeral${c.reset}` : `${c.cyan}persisted${c.reset}`;
                    const details = Object.entries(msg.payload ?? {})
                        .filter(([k]) => k !== 'event')
                        .map(([k, v]) => `${c.gray}${k}${c.reset}=${c.yellow}${typeof v === 'object' ? JSON.stringify(v) : v}${c.reset}`)
                        .join('  ');
                    console.log(`     ${c.bold}${c.magenta}← WS${c.reset}  ${c.bold}${c.cyan}${event}${c.reset}  [${persist}]${details ? `  ${details}` : ''}`);
                    this._deliver(msg);
                } catch (err) {
                    console.error(`     ${c.red}WS parse error:${c.reset}`, err.message);
                }
            });

            this.ws.on('close', () => {
                console.log(`     ${c.gray}── WebSocket closed ──${c.reset}`);
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

    /** Wait for a message whose payload.event === eventName */
    waitFor(eventName, ms = 20000) {
        return this._wait(
            msg => msg.payload?.event === eventName,
            ms,
            `Timeout (${ms}ms) waiting for WS event: ${eventName}`,
        );
    }

    /** Wait for the first message whose payload.event is in eventNames */
    waitForAny(eventNames, ms = 20000) {
        const set = new Set(eventNames);
        return this._wait(
            msg => set.has(msg.payload?.event),
            ms,
            `Timeout (${ms}ms) waiting for WS events: ${eventNames.join(' | ')}`,
        );
    }

    _wait(matchFn, ms, errorMsg) {
        // Flush queue first — the event may have arrived before we started waiting
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

    close() {
        if (this.ws) { this.ws.close(); this.ws = null; }
    }
}

const notifications = new NotificationCollector();

async function delay(ms){
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Test Suite ─────────────────────────────────────────────────────────────

(async () => {
    console.log(`\n${c.bold}${c.blue}── Order Workflow Tests ─────────────────────────────────${c.reset}`);
    console.log(`   ${c.gray}user:${c.reset} ${USERNAME}  ${c.gray}gateway:${c.reset} ${GATEWAY_HOST}:${GATEWAY_PORT}\n`);

    // ── 1. Auth setup ─────────────────────────────────────────────────────

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
        assert(status === 200,                   `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string', 'Missing accessToken');
        accessToken = body.accessToken;
    });

    // ── 2. Open WebSocket BEFORE creating the order ───────────────────────
    // The notify-service delivers immediately to online clients (no DB persist).
    // The socket must be open before any event fires.

    await test('WebSocket connects to /notify with JWT', async () => {
        await notifications.connect(accessToken);
        // If connect() resolved, the WS open event fired — connection is live
    });

    // ── 3. Browse inventory ───────────────────────────────────────────────

    await test('GET /items → queues request, WS delivers items_response', async () => {
        const { status } = await request(
            'GET', '/items/',
            null,
            { Authorization: `Bearer ${accessToken}` },
        );
        assert(status === 200, `Expected 200, got ${status}`);

        const msg = await notifications.waitFor('items_response', 10000);
        assert(Array.isArray(msg.payload.items),  'payload.items should be an array');
        assert(msg.payload.items.length > 0,      'Inventory should have at least one item');

        msg.payload.items.forEach(item => {
            assert(typeof item.itemId === 'string', 'item.itemId should be a string');
            assert(typeof item.name   === 'string', 'item.name should be a string');
            assert(typeof item.stock  === 'number', 'item.stock should be a number');
            assert(typeof item.price  === 'number', 'item.price should be a number');
        });

        // Pick up to 2 in-stock items for the order
        selectedItems = msg.payload.items
            .filter(i => i.stock >= 2)
            .slice(0, 2)
            .map(i => ({ itemId: i.itemId, quantity: 2, price: i.price }));

        assert(selectedItems.length > 0, 'Need at least one item with stock ≥ 2 to proceed');
        console.log(`     ${c.gray}selected:${c.reset}`);
        selectedItems.forEach(i => console.log(`       ${c.cyan}${i.itemId}${c.reset}  qty=${c.yellow}${i.quantity}${c.reset}  price=${c.green}$${i.price}${c.reset}`));
    });

    // ── 4. Create order ───────────────────────────────────────────────────

    await test('POST /order → 200 initiates order creation', async () => {
        paymentRequestId = `create-${Date.now()}`;

        const { status, body } = await request(
            'POST', '/order/',
            {
                itemList: selectedItems,
            },
            {
                Authorization:  `Bearer ${accessToken}`,
                'x-request-id': paymentRequestId,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(
            typeof body === 'string' && body.toLowerCase().includes('initiated'),
            `Unexpected response: ${JSON.stringify(body)}`,
        );
    });

    // ── 5. Await payment_intent_created notification ───────────────────────
    // Chain: cms.order.create → CMS SOAP → order.created
    //        → PaymentService intent → order.payment.intent_created
    //        → OrderService → notify.payment.intent_created → WS

    await test('WS: payment_intent_created notification received', async () => {
        const msg = await notifications.waitFor('payment_intent_created', 20000);

        assert(msg.persist === 0,                          `Expected persist 0 (non-persistent), got '${msg.persist}'`);
        assert(typeof msg.payload.clientSecret === 'string', 'clientSecret missing or not a string');
        assert(msg.payload.idempotencyKey === paymentRequestId, `idempotencyKey mismatch: expected '${paymentRequestId}', got '${msg.payload.idempotencyKey}'`);

        clientSecret = msg.payload.clientSecret;
        orderId = msg.payload.orderId;
        console.log(`     ${c.gray}orderId:${c.reset}      ${c.cyan}${orderId}${c.reset}`);
        console.log(`     ${c.gray}clientSecret:${c.reset} ${c.yellow}${clientSecret}${c.reset}`);
    });

    // Dummy payment handling
    paymentToken = clientSecret + '-token'; 


    // ── 6. Confirm order (order_confirmed + paymentToken) ──────────────────

    await test('PATCH /order → 200 initiates order confirmation', async () => {
        const { status, body } = await request(
            'PATCH', '/order/',
            {
                orderId,
                status:       'order_confirmed',
                data: {
                paymentToken: paymentToken,
                }
            },
            {
                Authorization:  `Bearer ${accessToken}`,
                'x-request-id': `confirm-${Date.now()}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(
            typeof body === 'string' && body.toLowerCase().includes('initiated'),
            `Unexpected response: ${JSON.stringify(body)}`,
        );
    });

    // ── 7. Await final payment outcome ─────────────────────────────────────
    // Chain: cms.order.update_status → CMS SOAP → order.confirmed
    //        → WMSAdapter reserve → order.wms.reserved
    //        → OrderService → payment.charge
    //        → PaymentService dummy charge → order.payment.completed | order.payment.failed
    //        → OrderService → notify.order.status → WS
    //
    // The dummy provider succeeds ~90% of the time; we accept either outcome.

    await test('WS: payment_completed or payment_failed notification received', async () => {
        const msg = await notifications.waitForAny(
            ['payment_completed', 'payment_failed'],
            30000,
        );

        assert(msg.persist === 0,      `Expected persist 0 (non-persistent), got '${msg.persist}'`);
        assert(msg.payload.orderId === orderId, `orderId mismatch: got ${msg.payload.orderId}`);

        if (msg.payload.event === 'payment_completed') {
            assert(typeof msg.payload.transactionId === 'string', 'transactionId missing');
            console.log(`       ✓ payment succeeded — transactionId: ${msg.payload.transactionId}`);
        } else {
            console.log(`       ✓ payment failed (expected ~10%) — reason: ${msg.payload.reason}`);
        }
    });


    // ── 8. Reservation-failure path: order with unknown item ──────────────
    // POST a new order with a non-existent itemId → WMS rejects → reservation_failed

    await test('WS: reservation_failed when itemId does not exist', async () => {
        const badRequestId = `create-bad-${Date.now()}`;
        const badItemList  = [{ itemId: 'item-does-not-exist', quantity: 1 }];

        const { status } = await request(
            'POST', '/order/',
            { itemList: badItemList },
            {
                Authorization:  `Bearer ${accessToken}`,
                'x-request-id': badRequestId,
            },
        );
        assert(status === 200, `Expected 200, got ${status}`);

        // Await: payment_intent_created fires first (PaymentService doesn't check stock)
        const intentMsg = await notifications.waitFor('payment_intent_created', 20000);
        const badOrderId = intentMsg.payload.orderId;
        assert(typeof badOrderId === 'string', 'orderId missing from payment_intent_created');

        // Confirm the bad order
        await request(
            'PATCH', '/order/',
            {
                orderId: badOrderId,
                status:  'order_confirmed',
                data: {
                    paymentToken: intentMsg.payload.clientSecret,
                    itemList:     badItemList,
                },
            },
            {
                Authorization:  `Bearer ${accessToken}`,
                'x-request-id': `confirm-bad-${Date.now()}`,
            },
        );

        // WMS will reject the unknown item → reservation_failed
        const failMsg = await notifications.waitFor('reservation_failed', 20000);
        assert(failMsg.payload.orderId === badOrderId,  `orderId mismatch: ${failMsg.payload.orderId}`);
        assert(typeof failMsg.payload.reason === 'string', 'reason field missing');
        console.log(`       ✓ reservation_failed received — reason: ${failMsg.payload.reason}`);
    });

    // ── Teardown ──────────────────────────────────────────────────────────

    notifications.close();
    summary();
})();
