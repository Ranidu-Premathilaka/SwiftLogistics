const InternalRouter = require('../utility/internalRouter');
const PubSub        = require('../utility/pubsub');
const config        = require('./config');

const pubsub = new PubSub(config.rabbitmq.url, config.rabbitmq.exchange, config.rabbitmq.queue);
const internalRouter = new InternalRouter();

// In-memory store: correlationId → { paymentToken, clientId }
// Populated when the client sends PATCH /order with a paymentToken.
// Cleared once payment is resolved (success or failure).
const pendingPayments = new Map();



// ── HTTP route handlers ────────────────────────────────────────────────────

async function createOrder({itemList , 'x-request-id': idempotencyKey, 'x-username': clientId}) {
    if (!clientId || !itemList|| !idempotencyKey) {
        internalRouter.sendRoutingError('Missing required fields', 400);
    }

    console.log(`[OrderService] createOrder: clientId=${clientId}`);
    const correlationId = idempotencyKey;
    orderData = {
        itemList
    };

    await pubsub.publish(config.publishedRoutingKeys.createOrder, { correlationId, clientId, orderData});
    console.log(`[OrderService] sent order creation event, correlationId=${correlationId}`);
    return 'Order creation initiated';
}

/**
 * GET /order
 * Headers: x-username (injected by API Gateway), x-request-id
 * Publishes cms.orders.requested; the actual order list is delivered via WebSocket.
 */
async function getOrders({ 'x-username': clientId}) {
    if (!clientId) {
        internalRouter.sendRoutingError('Missing required fields', 400);
    }

    // Encode the userId directly into the correlationId so the response handler
    // can recover it without an in-memory map.
    const correlationId = `userId-${clientId}`;
    console.log(`[OrderService] getOrders: clientId=${clientId}, correlationId=${correlationId}`);

    await pubsub.publish(config.publishedRoutingKeys.getOrders, { correlationId, userId: clientId });
    console.log(`[OrderService] Published cms.orders.requested for clientId=${clientId}`);
    return 'Order query initiated';
}

/**
 * PATCH /order
 * Body: { orderId, status: 'order_confirmed' , data: { paymentToken|| anything else according to the status change } }
 * Headers: x-username (injected by API Gateway), x-request-id (idempotency key)
 * Note: itemList is NOT needed here — it was stored in the CMS when the order was created
 * and will be retrieved by the CMS adapter when it publishes order.confirmed.
 */
async function updateOrderStatus({ orderId, status, data, 'x-username': bodyClientId, 'x-request-id': bodyIdempotency, headers = {} }) {
    const clientId       = bodyClientId   || headers['x-username'];
    const idempotencyKey = bodyIdempotency || headers['x-request-id'];

    if (!orderId || !status) {
        internalRouter.sendRoutingError('Missing required fields', 400);
    }

    switch (status) {
        case config.updateOrderStatus.orderConfirmed: {
            if (!data || !data.paymentToken) {
                internalRouter.sendRoutingError('paymentToken is required for order_confirmed', 400);
            }

            const correlationId = idempotencyKey || orderId;

            // Stash the paymentToken — PaymentService needs it later in the chain
            pendingPayments.set(correlationId, { paymentToken: data.paymentToken, clientId });
            console.log(`[OrderService] Stored paymentToken for correlationId=${correlationId}`);

            await pubsub.publish(config.publishedRoutingKeys.updateOrderStatus, { correlationId, orderId, status: config.updateOrderStatus.orderConfirmed });
            console.log(`[OrderService] sent cms.order.update_status, correlationId=${correlationId}`);
            return 'Order confirmation initiated';
        }
        default:
            internalRouter.sendRoutingError('Invalid status value', 400);
            return false;
    }
}


// ── Event handlers (choreography) ─────────────────────────────────────────

/** order.status_updated — CMS has processed a status change */
async function handleOrderStatusUpdated({ correlationId, orderData}) {

    if (!correlationId || !orderData || !orderData.orderId || !orderData.status) {
        console.error('[OrderService] handleOrderStatusUpdated: missing fields');
        return;
    }

    const { orderId, itemList, status } = orderData;
    switch (status) {
        case config.updateOrderStatus.orderConfirmed: {
            await pubsub.publish(config.publishedRoutingKeys.orderConfirmed, { correlationId, orderId, itemList });
            console.log(`[OrderService] Published order.confirmed for orderId=${orderId}`);
            break;
        }
        default: {
            // Notify user of the generic status change
            console.log(`[OrderService] Status update notified for orderId=${orderId}, status=${status} [NOT IMPLEMENTED]`);
        }
    }
}

/** order.wms.reserved — WMS successfully reserved the product */
async function handleWmsReserved({ correlationId, orderId, reservationId }) {
    if (!correlationId || !orderId) {
        console.error('[OrderService] handleWmsReserved: missing fields');
        return;
    }

    console.log(`[OrderService] WMS reserved orderId=${orderId}, reservationId=${reservationId}`);

    const pending = pendingPayments.get(correlationId);
    if (!pending) {
        console.error(`[OrderService] handleWmsReserved: no pending payment found for correlationId=${correlationId}`);
        return;
    }

    // Forward to PaymentService: charge the customer
    await pubsub.publish('payment.charge', {
        correlationId,
        orderId,
        paymentToken: pending.paymentToken,
    });
    console.log(`[OrderService] Forwarded payment.charge for orderId=${orderId}`);
}

/** order.wms.reservation_failed — WMS could not reserve the product */
async function handleWmsReservationFailed({ correlationId, orderId, error }) {
    if (!correlationId || !orderId) {
        console.error('[OrderService] handleWmsReservationFailed: missing fields');
        return;
    }

    console.warn(`[OrderService] WMS reservation failed for orderId=${orderId}: ${error}`);

    const pending = pendingPayments.get(correlationId);
    const clientId = pending?.clientId;
    pendingPayments.delete(correlationId);

    // Notify the user
    if (clientId) {
        await pubsub.publish(config.publishedRoutingKeys.notifyReservationFailed, {
            persist: 0,
            userId:  clientId,
            payload: { event: 'reservation_failed', orderId, reason: error },
        });
    }
}

/** order.payment.completed — PaymentService successfully charged */
async function handlePaymentCompleted({ correlationId, orderId, transactionId }) {
    if (!correlationId || !orderId) {
        console.error('[OrderService] handlePaymentCompleted: missing fields');
        return;
    }

    console.log(`[OrderService] Payment completed for orderId=${orderId}, transactionId=${transactionId}`);

    const pending = pendingPayments.get(correlationId);
    const clientId = pending?.clientId;
    pendingPayments.delete(correlationId);

    // Notify the user of successful payment
    if (clientId) {
        await pubsub.publish(config.publishedRoutingKeys.notifyPaymentCompleted, {
            persist: 0,
            userId:  clientId,
            payload: { event: 'payment_completed', orderId, transactionId },
        });
    }
}

/** order.payment.failed — PaymentService charge was declined */
async function handlePaymentFailed({ correlationId, orderId, error }) {
    if (!correlationId || !orderId) {
        console.error('[OrderService] handlePaymentFailed: missing fields');
        return;
    }

    console.warn(`[OrderService] Payment failed for orderId=${orderId}: ${error}`);

    const pending = pendingPayments.get(correlationId);
    const clientId = pending?.clientId;
    pendingPayments.delete(correlationId);

    // Tell WMS to release the reservation
    await pubsub.publish(config.publishedRoutingKeys.releaseReservation, { correlationId, orderId });

    // Notify the user
    if (clientId) {
        await pubsub.publish(config.publishedRoutingKeys.notifyPaymentFailed, {
            persist: 0,
            userId:  clientId,
            payload: { event: 'payment_failed', orderId, reason: error },
        });
    }
}

/** order.cms.order_response — CMS adapter responded with orders for a user */
async function handleCmsOrderResponse({ correlationId, orders }) {
    if (!correlationId || !correlationId.startsWith('userId-')) {
        console.error('[OrderService] handleCmsOrderResponse: missing or unrecognised correlationId', correlationId);
        return;
    }

    // Recover the clientId directly from the correlationId — no map lookup needed.
    const clientId = correlationId.slice('userId-'.length);
    console.log(`[OrderService] Received ${Array.isArray(orders) ? orders.length : 0} order(s) for userId=${clientId}`);

    await pubsub.publish(config.publishedRoutingKeys.notifyOrderQueryResponse, {
        persist: 0,
        userId:  clientId,
        payload: { event: 'order_query_response', orders: orders ?? [] },
    });
    console.log(`[OrderService] Published notify.client.order_query_response for userId=${clientId}`);
}


// ── Bootstrap ─────────────────────────────────────────────────────────────

(async () => {
    internalRouter.registerRoute('POST',  '/', createOrder);
    internalRouter.registerRoute('PATCH', '/', updateOrderStatus);
    internalRouter.registerRoute('GET',   '/', getOrders);

    await pubsub.connect();
    pubsub.subscribe(config.subscribedRoutingKeys.orderStatusUpdated,    handleOrderStatusUpdated);
    pubsub.subscribe(config.subscribedRoutingKeys.wmsReserved,           handleWmsReserved);
    pubsub.subscribe(config.subscribedRoutingKeys.wmsReservationFailed,  handleWmsReservationFailed);
    pubsub.subscribe(config.subscribedRoutingKeys.paymentCompleted,      handlePaymentCompleted);
    pubsub.subscribe(config.subscribedRoutingKeys.paymentFailed,         handlePaymentFailed);
    pubsub.subscribe(config.subscribedRoutingKeys.cmsOrderResponse,      handleCmsOrderResponse);

    internalRouter.host(config.port);
    console.log(`[OrderService] Listening on port ${config.port}`);
})();
