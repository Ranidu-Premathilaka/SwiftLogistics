module.exports = {
  port: process.env.PORT || 3000,

  rabbitmq: {
    url:      process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq-service:5672',
    exchange: 'swift_logistics',
  },

  // Wildcard routing key — matches all notify.* events published on the exchange.
  // Each horizontally-scaled instance of notify-service gets its own exclusive queue
  // so that ALL instances receive every notification and can serve whichever
  // client is connected to them.
  subscribedRoutingKey: 'notify.#',
};
