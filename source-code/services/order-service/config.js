module.exports = {
    rabbitMQ: {
        url: process.env.RABBITMQ_URL || 'amqp://localhost',
        exchangeName: 'order_exchange',
        queueName: 'orders_queue'
    }
};
