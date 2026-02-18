module.exports = {
    rabbitMQ: {
        url: process.env.RABBITMQ_URL || 'amqp://localhost',
        exchangeName: 'order_exchange', // Same exchange as order-service
        queueName: 'notifications_queue'
    }
};
