const pubsub = require('../utility/pubsub');
const config = require('./config');

const RABBITMQ_URL = config.rabbitMQ.url;
const EXCHANGE_NAME = config.rabbitMQ.exchangeName; 
const ps = new pubsub(RABBITMQ_URL, EXCHANGE_NAME);

async function startService() {
    await ps.connect();
    
    // Simulate user calling orderItem
    console.log("Simulating user ordering item '12345'...");
    orderItem('12345');
}

/**
 * Dummy method to simulate ordering an item.
 * @param {string} itemId 
 */
async function orderItem(itemId) {
    console.log(`[OrderService] Received order for item: ${itemId}`);
    
    // Simulate processing logic
    const orderId = `ORD-${Math.floor(Math.random() * 10000)}`;
    const userId = "user-007"; // Dummy user
    
    const orderData = {
        orderId: orderId,
        itemId: itemId,
        userId: userId,
        status: 'placed',
        timestamp: new Date().toISOString()
    };
    
    console.log(`[OrderService] Order processed: ${orderId}`);

    // Send notification upon success
    const notificationPayload = {
        type: 'ORDER_SUCCESS',
        payload: orderData
    };
    
    await ps.publish('notification.send', notificationPayload);
}

// Keep the service running
setInterval(() => {}, 1000);

startService();
