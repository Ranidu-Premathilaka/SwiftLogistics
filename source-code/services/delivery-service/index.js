const InternalRouter = require('../utility/internalRouter');
const PubSub        = require('../utility/pubsub');
const config        = require('./config');

const pubsub        = new PubSub(config.rabbitmq.url, config.rabbitmq.exchange, config.rabbitmq.queue);
const internalRouter = new InternalRouter();

// ── In-memory state ────────────────────────────────────────────────────────

// correlationId → { driverUsername, count }
// Populated on POST /deliveries; cleared once order response arrives.
const pendingRequests = new Map();

// correlationId → { orders, driverUsername }
// Populated once delivery.order.response arrives; cleared once route path response arrives.
const pendingRoutes = new Map();

// correlationId → { driverUsername, route }
// Populated once the optimized path arrives; cleared once driver is notified.
const pendingNotifications = new Map();


// ── HTTP route handlers ────────────────────────────────────────────────────

/**
 * POST /
 * Body:    { count }
 * Headers: x-role (injected by API Gateway), x-username, x-request-id
 *
 * Driver requests an assignment of `count` packages for delivery.
 * Publishes order.delivery.request_next; the actual route is delivered via WebSocket.
 */
async function requestDelivery({ count, 'x-role': role, 'x-username': driverUsername, 'x-request-id': idempotencyKey }) {
    if (role !== 'driver') {
        InternalRouter.sendRoutingError('Only drivers can request deliveries', 403);
    }

    const packageCount = parseInt(count, 10);
    if (!packageCount || packageCount < 1) {
        InternalRouter.sendRoutingError('count must be a positive integer', 400);
    }

    const correlationId = idempotencyKey; 
    console.log(`[DeliveryService] requestDelivery: driver=${driverUsername}, count=${packageCount}, correlationId=${correlationId}`);

    pendingRequests.set(correlationId, { driverUsername, count: packageCount });

    await pubsub.publish(config.publishedRoutingKeys.deliveryRequestNext, {
        correlationId,
    });

    return 'Delivery request initiated — you will receive your route via notification';
}


// ── Event handlers (choreography) ─────────────────────────────────────────

/**
 * delivery.order.response
 * Payload: { correlationId, order: { orderId, destination, storageCount } | null }
 *
 * Order-service has fetched the single oldest pending delivery order.
 * Forward to the route service with `count` so it can fill the remaining
 * stops from its orderId→location index.
 */
async function handleDeliveryOrderResponse({ correlationId, order }) {
    if (!correlationId) {
        console.error('[DeliveryService] handleDeliveryOrderResponse: missing correlationId');
        return;
    }

    const { driverUsername, count } = pendingRequests.get(correlationId) ?? {};
    pendingRequests.delete(correlationId);

    if (!order) {
        console.warn(`[DeliveryService] No pending delivery order for driver=${driverUsername}`);
        await pubsub.publish(config.publishedRoutingKeys.notifyDriverRoute, {
            persist: 0,
            userId:  driverUsername,
            payload: { event: 'driver_route', message: 'No pending delivery orders available', route: [] },
        });
        return;
    }

    console.log(`[DeliveryService] Anchor order=${order.orderId}, requesting optimized path from route-service`);

    pendingRoutes.set(correlationId, { driverUsername });

    await pubsub.publish(config.publishedRoutingKeys.pathRequested, {
        correlationId,
        anchorOrder: { orderId: order.orderId, location: order.destination },
        count,
    });
    console.log(`[DeliveryService] Published route.delivery.path_requested, correlationId=${correlationId}`);
}

/**
 * delivery.route.path_response
 * Payload: { correlationId, optimizedPath: string[] }
 *
 * Route-service has calculated the optimized path.
 * Ask order-service to mark all orders as on_route.
 */
async function handleRoutePathResponse({ correlationId, optimizedPath }) {
    if (!correlationId) {
        console.error('[DeliveryService] handleRoutePathResponse: missing correlationId');
        return;
    }

    const pending = pendingRoutes.get(correlationId);
    if (!pending) {
        console.error(`[DeliveryService] handleRoutePathResponse: no pending route for correlationId=${correlationId}`);
        return;
    }

    const { driverUsername } = pending;
    pendingRoutes.delete(correlationId);

    // optimizedPath is [{ orderId, location }, ...] — extract all orderIds
    const orderIds = optimizedPath.map(stop => stop.orderId).filter(Boolean);

    console.log(`[DeliveryService] Received optimized path for driver=${driverUsername}: ${JSON.stringify(optimizedPath)}`);

    // Stash driver + route so handleOrderCollected can notify without order-service forwarding them
    pendingNotifications.set(correlationId, { driverUsername, route: optimizedPath });

    await pubsub.publish(config.publishedRoutingKeys.markCollected, {
        correlationId,
        orderIds,
    });
    console.log(`[DeliveryService] Published delivery.order.mark_collected, correlationId=${correlationId}`);
}

/**
 * delivery.order.collected
 * Payload: { correlationId, driverUsername, route }
 *
 * Order-service confirmed all status updates.
 * Notify the driver with their route.
 */
async function handleOrderCollected({ correlationId }) {
    if (!correlationId) {
        console.error('[DeliveryService] handleOrderCollected: missing correlationId');
        return;
    }

    const pending = pendingNotifications.get(correlationId);
    if (!pending) {
        console.error(`[DeliveryService] handleOrderCollected: no pending notification for correlationId=${correlationId}`);
        return;
    }

    const { driverUsername, route } = pending;
    pendingNotifications.delete(correlationId);

    console.log(`[DeliveryService] Orders confirmed, notifying driver=${driverUsername}`);

    await pubsub.publish(config.publishedRoutingKeys.notifyDriverRoute, {
        persist: 0,
        userId:  driverUsername,
        payload: { event: 'driver_route', route: route ?? [] },
    });
    console.log(`[DeliveryService] Published notify.driver.route for driver=${driverUsername}`);
}


// ── Bootstrap ─────────────────────────────────────────────────────────────

(async () => {
    internalRouter.registerRoute('POST', '/', requestDelivery);

    await pubsub.connect();
    pubsub.subscribe(config.subscribedRoutingKeys.deliveryOrderResponse, handleDeliveryOrderResponse);
    pubsub.subscribe(config.subscribedRoutingKeys.routePathResponse,     handleRoutePathResponse);
    pubsub.subscribe(config.subscribedRoutingKeys.orderCollected,        handleOrderCollected);

    internalRouter.host(config.port);
    console.log(`[DeliveryService] Listening on port ${config.port}`);
})();
