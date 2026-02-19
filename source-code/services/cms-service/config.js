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
  routingKeys: {
    clientAuthenticate: 'cms.client.authenticate',
    getClientOrders:    'cms.client.orders.get',
    getOrderInfo:       'cms.order.info.get',
    createOrder:        'cms.order.create',
    updateOrder:        'cms.order.update',
    deleteOrder:        'cms.order.delete',
  },

  // Routing key prefix used when publishing replies
  replyRoutingKey: 'cms.reply',
};
