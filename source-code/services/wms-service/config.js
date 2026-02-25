// WMS Adapter Service Configuration

module.exports = {
  // Port the legacy WMS HTTP server listens on (internal only, not exposed)
  port: 3000,

  // RabbitMQ connection
  rabbitmq: {
    url:      process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq-service:5672',
    exchange: 'swift_logistics',
    queue:    'wms_adapter_queue',
  },

  // Routing keys this adapter subscribes to
  subscribedRoutingKeys: {
    // { correlationId, orderId, itemList } — triggered after CMS confirms the order
    orderConfirmed:     'order.confirmed',
    // { correlationId, orderId } — triggered when payment fails; release the reservation
    releaseReservation: 'wms.order.release',
    // { correlationId } — request for the current inventory list
    itemsRequest:       'wms.items.request',
  },

  // Routing keys this adapter publishes on
  publishedRoutingKeys: {
    // { correlationId, orderId, reservationId }
    wmsReserved:          'order.wms.reserved',
    // { correlationId, orderId, error }
    wmsReservationFailed: 'order.wms.reservation_failed',
    // { correlationId, items: [{ itemId, name, stock }] }
    wmsItemsResponse:     'wms.items.response',
  },
};
