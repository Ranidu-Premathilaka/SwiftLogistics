/**
 * Items Service
 *
 * Exposes warehouse inventory to clients via a simple HTTP GET.
 * Internally it fires a wms.items.request event and awaits a wms.items.response
 * via an async RabbitMQ RPC pattern — the legacy WMS is never reachable directly.
 *
 * Route (exposed via API Gateway as GET /items):
 *   GET /  → { items: [{ itemId, name, stock }] }
 */

const InternalRouter = require('../utility/internalRouter');
const PubSub        = require('../utility/pubsub');
const config        = require('./config');

const pubsub        = new PubSub(config.rabbitmq.url, config.rabbitmq.exchange, config.rabbitmq.queue);
const internalRouter = new InternalRouter();

const pendingItemRequests = new Map(); 

// ── RabbitMQ response handler ─────────────────────────────────────────────

function handleWmsItemsResponse({correlationId,items}) {
    console.log(`[ItemsService] Received items response from WMS: ${items.length} items`);
    clientId = pendingItemRequests.get(correlationId);
    data = {
        persist: false,
        userId : clientId,
        payload : items,
    }
    pubsub.publish(config.publishedRoutingKeys.notifyClientItemsResponse, data);
    pendingItemRequests.delete(correlationId);
}

// ── HTTP route handler ────────────────────────────────────────────────────

// GET /items
async function getItems({'x-username': clientId}) {
    const correlationId = `items_request_${Date.now()}`;
    pendingItemRequests.set(correlationId, clientId);
    pubsub.publish(config.publishedRoutingKeys.wmsItemsRequest, { correlationId });
    return "Requesting items from WMS";
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

(async () => {
    internalRouter.registerRoute('GET', '/', getItems);

    await pubsub.connect();
    pubsub.subscribe(config.subscribedRoutingKeys.wmsItemsResponse, handleWmsItemsResponse);

    internalRouter.host(config.port);
    console.log(`[ItemsService] Listening on port ${config.port}`);
})();
