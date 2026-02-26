// Route Service Configuration

module.exports = {

    rabbitmq: {
        url:      process.env.RABBITMQ_URL || 'amqp://localhost',
        exchange: 'swift_logistics',
        queue:    'route-service-queue',
    },

    // Statuses that remove an order from the route-filling index
    removalStatuses: ['on_route', 'delivered', 'cancelled', 'failed', 'payment_failed'],

    publishedRoutingKeys: {
        // { correlationId, locations } → RMS adapter
        rmsOptimize:          'rms.route.optimize',
        // { correlationId, optimizedPath } → delivery-service
        deliveryPathResponse: 'delivery.route.path_response',
    },

    subscribedRoutingKeys: {
        // { correlationId, orderData: { orderId, status, destination, ... } } — from CMS adapter
        // Used to add (pending_delivery) or remove (on_route / cancelled / failed) index entries
        orderStatusUpdated:  'order.status_updated',
        // { correlationId, anchorOrder, count, driverUsername } — from delivery-service
        pathRequested:       'route.delivery.path_requested',
        // { correlationId, success, data: { optimizedPath } } — from RMS adapter
        rmsReply:            'rms.reply',
    },
};
