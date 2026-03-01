// Delivery Service Configuration

module.exports = {

    port: process.env.PORT || 3000,

    rabbitmq: {
        url:      process.env.RABBITMQ_URL || 'amqp://localhost',
        exchange: 'swift_logistics',
        queue:    'delivery-service-queue',
    },

    publishedRoutingKeys: {
        // { correlationId, count, driverUsername } → order-service
        deliveryRequestNext:  'order.delivery.request_next',
        // { correlationId, orders, driverUsername } → route-service
        pathRequested:        'route.delivery.path_requested',
        // { correlationId, orderIds } → order-service
        markCollected:        'delivery.order.mark_collected',
        // { persist, userId, payload } → notify-service
        notifyDriverRoute:    'notify.driver.route',
        // { correlationId, orderId } → wms-adapter
        wmsStatusRequest:     'wms.delivery.status_request',
        // { persist, userId, payload } → notify-service
        notifyDeliveryStatus: 'notify.delivery.status',
    },

    subscribedRoutingKeys: {
        // { correlationId, driverUsername, orders } — from order-service
        deliveryOrderResponse:  'delivery.order.response',
        // { correlationId, optimizedPath } — from route-service
        routePathResponse:      'delivery.route.path_response',
        // { correlationId } — from order-service (all status updates done)
        orderCollected:         'delivery.order.collected',
        // { correlationId, orderId, deliveryStatus } — from wms-adapter
        wmsStatusResponse:      'wms.delivery.status_response',
    },
};
