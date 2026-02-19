module.exports = {
  // Port the legacy ROS HTTP server listens on (internal only, not exposed)
  port: 3000,

  // RabbitMQ connection
  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq-service:5672',
    exchange: 'swift_logistics',
    queue: 'rms_adapter_queue',
  },

  // Routing keys this adapter subscribes to
  routingKeys: {
    optimizeRoute: 'rms.route.optimize',
  },

  // Routing key prefix used when publishing replies
  replyRoutingKey: 'rms.reply',
};
