module.exports = {
  // Port the legacy WMS HTTP server listens on (internal only, not exposed)
  port: 3000,

  // RabbitMQ connection
  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq-service:5672',
    exchange: 'swift_logistics',
    queue: 'wms_adapter_queue',
  },

  // Routing keys this adapter subscribes to
  routingKeys: {
    itemInStock:      'wms.item.stock.check',
    itemOrder:        'wms.item.order',
    itemStatus:       'wms.item.status.get',
    updateItemStatus: 'wms.item.status.update',
    itemReceived:     'wms.item.received',
  },

  // Routing key prefix used when publishing replies
  replyRoutingKey: 'wms.reply',
};
