// Payment Service Configuration

module.exports = {
    rabbitmq: {
        url:      process.env.RABBITMQ_URL || 'amqp://localhost',
        exchange: 'swift_logistics',
        queue:    'payment-service-queue',
    },

    publishedRoutingKeys: {
        // { persist, userId, payload } → consumed by notify-service
        notifyPaymentIntentCreated: 'notify.payment.intent_created',
        // { correlationId, orderId, transactionId }
        paymentCompleted:     'order.payment.completed',
        // { correlationId, orderId, error }
        paymentFailed:        'order.payment.failed',
    },

    subscribedRoutingKeys: {
        // { correlationId, orderData } — published by CMS adapter after order.created
        orderCreated:  'order.created',
        // { correlationId, orderId, paymentToken } — published by OrderService after WMS reserves
        chargePayment: 'payment.charge',
    }
}