/**
 * Route Service
 *
 * Responsibilities:
 *   1. Maintain an in-memory orderId → destination mapping, populated whenever an
 *      order is created and confirmed by CMS (order.created event).
 *   2. When a delivery-service requests a path (route.delivery.path_requested):
 *        a. Take the single anchor order's location as the first stop.
 *        b. Fill up to `count` total stops by pulling other stored locations
 *           from the index (orders near the anchor that are also pending delivery).
 *        c. Call the RMS legacy system via rms.delivery.optimize with exactly
 *           those `count` locations.
 *   3. Relay the RMS reply as delivery.route.path_response back to the delivery-service.
 */
const PubSub = require('../utility/pubsub');
const config = require('./config');

const pubsub = new PubSub(config.rabbitmq.url, config.rabbitmq.exchange, config.rabbitmq.queue);

// ── In-memory orderId → location index ────────────────────────────────────
// Entries added when an order reaches 'pending_delivery' status.
// Entries removed when an order moves to a post-delivery or terminal status.
const orderLocationIndex = new Map();

const REMOVAL_STATUSES = new Set(config.removalStatuses);

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * findClosestStops(anchorLocation, candidates, count)
 *
 * Dummy proximity resolver — in production this would use geo-coordinates to
 * rank candidates by distance from the anchor and return the nearest `count-1`.
 * Here it simply returns the first (count - 1) candidates as-is.
 *
 * @param {string}                        anchorLocation - location of the anchor order
 * @param {{ orderId, location }[]}       candidates     - all other pending-delivery stops
 * @param {number}                        count          - total stops requested (including anchor)
 * @returns {{ orderId, location }[]}                    - up to (count - 1) stops to add
 */
function findClosestStops(anchorOrder, maxStops) {
    // Dummy: returns the first (maxStops - 1) entries from the index, excluding the anchor.
    // A real implementation would sort by haversine distance from anchorOrder.location.
    const stops = [];
    for (const [orderId, location] of orderLocationIndex) {
        if (stops.length >= maxStops - 1) break;
        if (orderId === anchorOrder.orderId) continue;
        stops.push({ id: orderId, location });
    }
    return stops;
}


// ── Event handlers ─────────────────────────────────────────────────────────

/**
 * order.status_updated
 * Payload: { correlationId, orderData: { orderId, status, destination, ... } }
 *
 * - pending_delivery  → add orderId→destination to the index (order is paid, awaiting pickup)
 * - on_route / delivered / cancelled / failed → remove from index
 */
async function handleOrderStatusUpdated({ orderData }) {
    const { orderId, status, destination } = orderData ?? {};
    if (!orderId || !status) return;

    if (status === 'pending_delivery') {
        if (!destination) {
            console.warn(`[RouteService] Order ${orderId} reached pending_delivery but has no destination — skipping index`);
            return;
        }
        orderLocationIndex.set(orderId, destination);
        console.log(`[RouteService] Indexed orderId=${orderId} → "${destination}" (total=${orderLocationIndex.size})`);
    } else if (REMOVAL_STATUSES.has(status)) {
        if (orderLocationIndex.delete(orderId)) {
            console.log(`[RouteService] Removed orderId=${orderId} from index (status=${status}, total=${orderLocationIndex.size})`);
        }
    }
}

/**
 * route.delivery.path_requested
 * Payload: { correlationId, orders: [{ orderId, location, storageCount }], driverUsername }
 *
 * Build the full location list and ask the RMS to optimise the path.
 *
 * Strategy:
/**
 * route.delivery.path_requested
 * Payload: { correlationId, anchorOrder: { orderId, location, storageCount }, count, driverUsername }
 *
 * The delivery-service provides a single anchor order (the oldest pending_delivery).
 * We fill up to `count` total stops by picking other orders from our index whose
 * destinations are not already included, then send the full list to RMS.
 */
async function handlePathRequested({ correlationId, anchorOrder, count }) {
    if (!correlationId || !anchorOrder) {
        console.error('[RouteService] handlePathRequested: missing fields');
        return;
    }

    const maxStops = Math.max(1, parseInt(count, 10) || 1);
    console.log(`[RouteService] Path requested, anchor=${anchorOrder.orderId}, maxStops=${maxStops}`);

    if (!anchorOrder.location) {
        console.warn('[RouteService] Anchor order has no location — cannot build route');
        await pubsub.publish(config.publishedRoutingKeys.deliveryPathResponse, {
            correlationId,
            optimizedPath: [],
        });
        return;
    }

    // Anchor is always first; findClosestStops fills the remaining slots from the index
    const stops = [
        { id: anchorOrder.orderId, location: anchorOrder.location },
        ...findClosestStops(anchorOrder, maxStops),
    ];

    console.log(`[RouteService] Sending ${stops.length} stop(s) to RMS for optimization`);

    await pubsub.publish(config.publishedRoutingKeys.rmsOptimize, {
        correlationId,
        locations: stops,
    });
}

/**
 * rms.reply
 * Payload: { correlationId, success, data: { optimizedPath } }
 *
 * RMS adapter has returned the optimized path; forward to delivery-service.
 */
async function handleRmsReply({ correlationId, success, data, error }) {
    if (!correlationId) {
        console.error('[RouteService] handleRmsDeliveryReply: missing correlationId');
        return;
    }


    if (!success) {
        console.error(`[RouteService] RMS path optimization failed: ${error}`);
        await pubsub.publish(config.publishedRoutingKeys.deliveryPathResponse, {
            correlationId,
            optimizedPath: [],
        });
        return;
    }

    const optimizedPath = (data?.optimizedPath ?? []).map(({ id, location }) => ({ orderId: id, location }));
    console.log(`[RouteService] RMS returned optimized path (${optimizedPath.length} stops), correlationId=${correlationId}`);

    await pubsub.publish(config.publishedRoutingKeys.deliveryPathResponse, {
        correlationId,
        optimizedPath,
    });
}


// ── Bootstrap ─────────────────────────────────────────────────────────────

(async () => {
    await pubsub.connect();

    pubsub.subscribe(config.subscribedRoutingKeys.orderStatusUpdated, handleOrderStatusUpdated);
    pubsub.subscribe(config.subscribedRoutingKeys.pathRequested,    handlePathRequested);
    pubsub.subscribe(config.subscribedRoutingKeys.rmsReply, handleRmsReply);

    console.log('[RouteService] Connected to RabbitMQ and listening for events.');
})();
