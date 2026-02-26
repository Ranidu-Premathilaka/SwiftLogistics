const PubSub        = require('../utility/pubsub');
const config        = require('./config');

const pubsub = new PubSub(config.rabbitmq.url, config.rabbitmq.exchange, config.rabbitmq.queue);

// ── Dummy payment provider ─────────────────────────────────────────────────────

async function dummyCreatePaymentIntent(amount, currency, clientId) {
    const clientSecret = Math.random().toString(36).slice(2);
    return { clientSecret };
}

/**
 * Dummy charge using a previously issued paymentToken (client secret).
 * In production this would call the real payment processor.
 * Returns { success, transactionId?, error? }
 */
async function dummyCharge(paymentToken, orderId) {
    if (!paymentToken) {
        return { success: false, error: 'No payment token provided' };
    }
    // Simulate a successful charge ~90% of the time
    if (Math.random() < 0.9) {
        const transactionId = `TXN-${orderId}-${Date.now()}`;
        return { success: true, transactionId };
    }
    return { success: false, error: 'Card declined (simulated)' };
}


// ── Event handlers ──────────────────────────────────────────────────────────

/** order.created — CMS confirmed order creation; create a payment intent so the client can confirm */
async function createPaymentIntent({ correlationId, clientId, orderData }) {
    if (!correlationId || !clientId || !orderData) {
        console.error('[PaymentService] createPaymentIntent: missing fields');
        return;
    }

    console.log(`[PaymentService] createPaymentIntent: clientId=${clientId}`);

    const orderId = orderData?.orderId;
    const { clientSecret } = await dummyCreatePaymentIntent(orderData.amount, orderData.currency, clientId);

    await pubsub.publish(config.publishedRoutingKeys.notifyPaymentIntentCreated, {
        persist:  0,
        userId:   clientId,
        payload:  { event: 'payment_intent_created', idempotencyKey: correlationId, orderId, clientSecret },
    });
    console.log(`[PaymentService] sent payment intent notification to client, correlationId=${correlationId}`);
}

/** payment.charge — OrderService requests a charge after WMS reservation succeeds */
async function handleChargePayment({ correlationId, orderId, paymentToken }) {
    if (!correlationId || !orderId || !paymentToken) {
        console.error('[PaymentService] handleChargePayment: missing fields');
        return;
    }

    console.log(`[PaymentService] Charging orderId=${orderId}`);

    const result = await dummyCharge(paymentToken, orderId);

    if (result.success) {
        await pubsub.publish(config.publishedRoutingKeys.paymentCompleted, {
            correlationId,
            orderId,
            transactionId: result.transactionId,
        });
        console.log(`[PaymentService] Payment completed for orderId=${orderId}, transactionId=${result.transactionId}`);
    } else {
        await pubsub.publish(config.publishedRoutingKeys.paymentFailed, {
            correlationId,
            orderId,
            error: result.error,
        });
        console.warn(`[PaymentService] Payment failed for orderId=${orderId}: ${result.error}`);
    }
}


// ── Bootstrap ─────────────────────────────────────────────────────────────

(async () => {
    await pubsub.connect();
    pubsub.subscribe(config.subscribedRoutingKeys.orderCreated,  createPaymentIntent);
    pubsub.subscribe(config.subscribedRoutingKeys.chargePayment, handleChargePayment);
    console.log('[PaymentService] Subscribed to RabbitMQ events.');
})();
