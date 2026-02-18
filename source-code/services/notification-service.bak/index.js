const pubsub = require('../utility/pubsub');
const config = require('./config');

const RABBITMQ_URL = config.rabbitMQ.url;
const EXCHANGE_NAME = config.rabbitMQ.exchangeName;
const QUEUE_NAME = config.rabbitMQ.queueName;

const ps = new pubsub(RABBITMQ_URL, EXCHANGE_NAME);

async function startService() {
    await ps.connect();
    
    // Listen for order success events
    // Routing key matches what order-service publishes: 'notification.send'
    await ps.subscribe('notification.send', QUEUE_NAME, handleNotification);
    
    console.log('[NotificationService] Service started. Waiting for messages...');
}

/**
 * Handle incoming notification messages
 * @param {object} message 
 */
function handleNotification(message) {
    // Expecting message structure: { type: 'ORDER_SUCCESS', payload: { ... } }
    console.log('[NotificationService] Received message:', message);

    if (message.type === 'ORDER_SUCCESS') {
        const orderData = message.payload;
        const userId = orderData.userId;
        
        console.log(`[NotificationService] Processing notification for User: ${userId}`);
        
        // Simulate fetching user and processing
        // ... (fetching user logic would go here) ...
        
        // Send dummy notification
        sendDummyNotification(userId, `Your order ${orderData.orderId} has been placed successfully!`);
    } else {
        console.log('[NotificationService] Unknown message type.');
    }
}

function sendDummyNotification(userId, text) {
    console.log(`\n--- NOTIFICATION SENT ---`);
    console.log(`To: ${userId}`);
    console.log(`Message: ${text}`);
    console.log(`-------------------------\n`);
}

startService();
