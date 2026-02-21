module.exports = {
  port: process.env.PORT || 3000,

  rabbitmq: {
    url:      process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq-service:5672',
    exchange: 'swift_logistics',
  },
};
