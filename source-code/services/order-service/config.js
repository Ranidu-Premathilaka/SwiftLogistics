// Order Service Configuration

module.exports = {

    port: process.env.PORT || 3000,

    rabbitmq: {
        url:      process.env.RABBITMQ_URL || 'amqp://localhost',
        exchange: 'swift_logistics',
        queue:    'order-service-queue',
    },

    // Accepted values for the PATCH /order status field
    updateOrderStatus: {
        orderConfirmed: 'order_confirmed',
    },

    publishedRoutingKeys: {
        // { correlationId, clientId, orderData }
        createOrder:        'cms.order.create',
        // { correlationId, orderId, status } → consumed by CMS adapter
        updateOrderStatus:  'cms.order.update_status',
        // { correlationId, orderId, itemList } → consumed by WMS adapter
        orderConfirmed:     'order.confirmed',
        // { correlationId, orderId } → tell WMS to release the reservation on payment failure
        releaseReservation: 'wms.order.release',
        // { correlationId, userId } → request all orders for a user from CMS
        getOrders:          'cms.orders.requested',
        // { persist, userId, payload } → consumed by notify-service
        notifyReservationFailed:    'notify.order.reservation_failed',
        notifyPaymentCompleted:     'notify.order.payment_completed',
        notifyPaymentFailed:        'notify.order.payment_failed',
        notifyOrderQueryResponse:   'notify.client.order_query_response',
        // { correlationId, count } → CMS adapter GetNextPendingDelivery
        cmsDeliveryRequestNext:     'cms.delivery.request_next',
        // { correlationId, order } → delivery-service
        deliveryOrderResponse:      'delivery.order.response',
        // { correlationId } → delivery-service (all status updates applied)
        orderCollected:             'delivery.order.collected',
    },

    subscribedRoutingKeys: {
        // { correlationId, orderId, status, itemList } — published by CMS adapter
        orderStatusUpdated:    'order.status_updated',
        // { correlationId, orderId, reservationId }
        wmsReserved:           'order.wms.reserved',
        // { correlationId, orderId, error }
        wmsReservationFailed:  'order.wms.reservation_failed',
        // { correlationId, orderId, transactionId }
        paymentCompleted:      'order.payment.completed',
        // { correlationId, orderId, error }
        paymentFailed:         'order.payment.failed',
        // { correlationId, userId, orders } — published by CMS adapter in response to getOrders
        cmsOrderResponse:      'order.cms.order_response',
        // { correlationId, count, driverUsername } — from delivery-service
        deliveryRequestNext:   'order.delivery.request_next',
        // { correlationId, orders } — from CMS adapter after GetNextPendingDelivery
        cmsDeliveryResponse:   'order.cms.delivery_response',
        // { correlationId, orderIds } — from delivery-service
        markCollected:         'delivery.order.mark_collected',
    }
};
