/**
 * Items Service
 *
 * Exposes warehouse inventory to clients via a simple HTTP GET.
 * Internally it fires a wms.items.request event and awaits a wms.items.response
 * via an async RabbitMQ RPC pattern — the legacy WMS is never reachable directly.
 *
 * Route (exposed via API Gateway as GET /items):
 *   GET /  → { items: [{ itemId, name, stock, price }] }
 */

const InternalRouter = require('../utility/internalRouter');
const PubSub        = require('../utility/pubsub');
const config        = require('./config');

const pubsub        = new PubSub(config.rabbitmq.url, config.rabbitmq.exchange, config.rabbitmq.queue);
const internalRouter = new InternalRouter();

const pendingItemRequests = new Map(); // correlationId → userId

// ── RabbitMQ response handler ─────────────────────────────────────────────

function handleWmsItemsResponse({ correlationId, items, error }) {
    console.log(`[ItemsService] Received items response from WMS: correlationId=${correlationId}`);
    const userId = pendingItemRequests.get(correlationId);
    if (!userId) {
        console.warn(`[ItemsService] No pending request for correlationId=${correlationId}`);
        return;
    }
    pendingItemRequests.delete(correlationId);

    pubsub.publish(config.publishedRoutingKeys.notifyClientItemsResponse, {
        persist:  0,
        userId,
        payload: { event: 'items_response', items: items ?? [], error },
    });
}

// ── HTTP route handler ────────────────────────────────────────────────────

// GET /items
async function getItems({ 'x-username': userId }) {
    const correlationId = `items_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    pendingItemRequests.set(correlationId, userId);
    pubsub.publish(config.publishedRoutingKeys.wmsItemsRequest, { correlationId });
    return 'Items request queued';
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

(async () => {
    internalRouter.registerRoute('GET', '/', getItems);

    await pubsub.connect();
    pubsub.subscribe(config.subscribedRoutingKeys.wmsItemsResponse, handleWmsItemsResponse);

    internalRouter.host(config.port);
    console.log(`[ItemsService] Listening on port ${config.port}`);
})();
