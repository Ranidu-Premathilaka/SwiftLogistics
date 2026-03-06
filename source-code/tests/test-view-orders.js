/**
 * View Orders Integration Test
 *
 * Tests the end-to-end "view orders" workflow:
 *   GET  /items          — browse inventory, pick an item
 *   POST /order          — create one order so there is something to fetch
 *   WS   notify          — await payment_intent_created (confirms order exists in CMS)
 *   GET  /order          — client requests their orders
 *                           → Order Service publishes  cms.orders.requested
 *                           → CMS Adapter calls SOAP GetOrdersByUser
 *                           → CMS Adapter publishes   order.cms.order_response
 *                           → Order Service publishes notify.client.order_query_response
 *   WS   notify          — receive order_query_response with the order list
 *
 * Requires the full stack to be running (./start.sh)
 *
 * Usage:
 *   node source-code/tests/test-view-orders.js
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

// Unique user per run to avoid state collisions
const USERNAME = `view_orders_test_${Date.now()}`;
const PASSWORD  = 'TestPass123!';

let accessToken   = null;
let selectedItem  = null;  // one item from GET /items
let createdOrderId = null; // orderId returned via payment_intent_created

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
                    const msg    = JSON.parse(raw.toString());
                    const event  = msg.payload?.event ?? '(no event)';
                    const persist = msg.persist === 0
                        ? `${c.gray}ephemeral${c.reset}`
                        : `${c.cyan}persisted${c.reset}`;
                    const details = Object.entries(msg.payload ?? {})
                        .filter(([k]) => k !== 'event')
                        .map(([k, v]) => `${c.gray}${k}${c.reset}=${c.yellow}${
                            typeof v === 'object' ? JSON.stringify(v) : v}${c.reset}`)
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

    waitFor(eventName, ms = 20000) {
        return this._wait(
            msg => msg.payload?.event === eventName,
            ms,
            `Timeout (${ms}ms) waiting for WS event: ${eventName}`,
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

    close() {
        if (this.ws) { this.ws.close(); this.ws = null; }
    }
}

const notifications = new NotificationCollector();

// ── Test Suite ────────────────────────────────────────────────────────────────

(async () => {
    console.log(`\n${c.bold}${c.blue}── View Orders Workflow Tests ────────────────────────────${c.reset}`);
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

    // ── 3. Browse inventory for a valid item ──────────────────────────────────

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

    // ── 4. Create one order so the CMS has data to return ─────────────────────
    //
    // Chain: POST /order
    //   → cms.order.create → CMS SOAP CreateOrder → order.created
    //   → PaymentService intent → order.payment.intent_created
    //   → OrderService → notify.payment.intent_created → WS

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
        assert(
            typeof body === 'string' && body.toLowerCase().includes('initiated'),
            `Unexpected response: ${JSON.stringify(body)}`,
        );
    });

    await test('WS: payment_intent_created confirms order was stored in CMS', async () => {
        const msg = await notifications.waitFor('payment_intent_created', 20000);
        assert(typeof msg.payload.orderId === 'string', 'orderId missing from payment_intent_created');
        createdOrderId = msg.payload.orderId;
        console.log(`     ${c.gray}createdOrderId:${c.reset} ${c.cyan}${createdOrderId}${c.reset}`);
    });

    // ── 5. Query orders ───────────────────────────────────────────────────────
    //
    // Chain: GET /order
    //   → Order Service publishes  cms.orders.requested  { correlationId, userId }
    //   → CMS Adapter calls SOAP   GetOrdersByUser({ clientId: userId })
    //   → CMS Adapter publishes    order.cms.order_response  { correlationId, userId, orders }
    //   → Order Service publishes  notify.client.order_query_response → WS

    await test('GET /order → 200 returns "Order query initiated"', async () => {
        const { status, body } = await request(
            'GET', '/order/',
            null,
            {
                Authorization:  `Bearer ${accessToken}`,
                'x-request-id': `get-orders-${Date.now()}`,
            },
        );
        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(
            typeof body === 'string' && body.toLowerCase().includes('initiated'),
            `Unexpected response: ${JSON.stringify(body)}`,
        );
    });

    await test('WS: order_query_response delivers the order list', async () => {
        const msg = await notifications.waitFor('order_query_response', 20000);

        assert(msg.persist === 0,                   `Expected persist 0 (ephemeral), got '${msg.persist}'`);
        assert(Array.isArray(msg.payload.orders),   'payload.orders should be an array');
        assert(msg.payload.orders.length > 0,       'Expected at least one order in the response');

        // Every order must have the required fields
        msg.payload.orders.forEach((order, i) => {
            assert(typeof order.orderId   === 'string', `orders[${i}].orderId should be a string`);
            assert(typeof order.clientId  === 'string', `orders[${i}].clientId should be a string`);
            assert(typeof order.status    === 'string', `orders[${i}].status should be a string`);
            assert(Array.isArray(order.itemList),        `orders[${i}].itemList should be an array`);
        });

        // The order we created earlier must appear in the list
        const found = msg.payload.orders.some(o => o.orderId === createdOrderId);
        assert(found, `Created order ${createdOrderId} not found in order_query_response`);

        console.log(`     ${c.green}${c.bold}✔ received ${msg.payload.orders.length} order(s)${c.reset}`);
        msg.payload.orders.forEach(o =>
            console.log(`       ${c.cyan}${o.orderId}${c.reset}  status=${c.yellow}${o.status}${c.reset}  items=${c.gray}${o.itemList.length}${c.reset}`)
        );
    });

    // ── Teardown ──────────────────────────────────────────────────────────────

    notifications.close();
    summary();
})();
