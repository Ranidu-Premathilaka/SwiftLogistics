// CMS Adapter Service Configuration

module.exports = {
  // Port the legacy CMS SOAP server listens on (internal only, not exposed)
  port: 3000,

  // Host the legacy CMS SOAP server binds to — must match server.listen() call
  host: '127.0.0.1',

  // RabbitMQ connection
  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq-service:5672',
    exchange: 'swift_logistics',
    queue: 'cms_adapter_queue',
  },

  // Routing keys this adapter subscribes to
  subscribedRoutingKeys: {
    // { correlationId, clientId, orderData }
    createOrder:       'cms.order.create',
    // { correlationId, orderId, status }
    updateOrderStatus: 'cms.order.update_status',
    // { correlationId, userId }
    getOrdersByUser:   'cms.orders.requested',
  },

  // Routing keys this adapter publishes on
  publishedRoutingKeys: {
    // { correlationId, orderData }
    orderCreated: 'order.created',
    // { correlationId, orderId, status }
    orderStatusUpdated: 'order.status_updated',
    // { correlationId, orderId } — emitted after UpdateOrderStatus succeeds
    orderConfirmed: 'order.confirmed',
    // { correlationId, userId, orders } — response to cms.orders.requested
    orderQueryResponse: 'order.cms.order_response',
  },

};
