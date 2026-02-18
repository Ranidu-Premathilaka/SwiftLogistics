const amqp = require('amqplib');

class PubSub {
    constructor(url, exchange, queue) {
        this.connection = null;
        this.channel = null;
        this.exchange = exchange;
        this.queue = queue;
        this.url = url;
        this.explicitClose = false;
        this.subscribers = []; 
    }

    async connect() {
        try {
            console.log(`[PubSub] Connecting to ${this.url}...`);
            this.connection = await amqp.connect(this.url);
            this.channel = await this.connection.createChannel();
            this.#init();
            console.log('[PubSub] Connected successfully.');

            this.connection.on('close', () => {
                this.connection = null;
                this.channel = null;
                if(this.explicitClose) {
                    console.log('[PubSub] Connection closed explicitly. Not reconnecting.');
                    return;
                }
                console.warn('[PubSub] Connection closed. Reconnecting in 5 seconds...');
                setTimeout(() => this.connect(), 5000);
            });
            
            this.connection.on('error', (err) => {
                console.error('[PubSub] Connection error:', err);
            });

        } catch (error) {
            console.error('[PubSub] Initial connection error:', error);
            setTimeout(() => this.connect(), 5000);
        }
    }

    async #init() {
        await this.channel.assertExchange(this.exchange, 'topic', { durable: true });
        this.subscribers.forEach(sub => {
            this.subscribe(sub.routingKey, sub.callback, true);
        });
    }

    /**
     * 
     * @param {string} routingKey  : Routing key for the message, ex: "order.created"
     * @param {object} data : The message payload to send ex: { orderId: "123", status: "created" }
     * @returns Boolean indicating if the message was sent successfully
     */
    async publish(routingKey, data) {
        while(!this.channel) {
            console.warn('[PubSub] Channel not ready. Queuing or dropping message.');
            await new Promise(resolve => setTimeout(resolve, 5000)); 
        }

        try {
            const buffer = Buffer.from(JSON.stringify(data));
            const sent = this.channel.publish(this.exchange, routingKey, buffer);
            console.log(`[PubSub] Published to ${this.exchange}:${routingKey}`);
            return sent;
        } catch (error) {
            console.error('[PubSub] Publish error:', error);
            return false;
        }
    }

    /**
     * 
     * @param {string} routingKey : Routing key for the subscription, ex: "order.created"
     * @param {function} callback : The callback function to handle received messages
     */
    async subscribe(routingKey, callback, restore = false) {
        while(!this.channel) {
            console.warn('[PubSub] Channel not ready. Retry subscribe later.');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        if(!restore){
            this.subscribers.push({routingKey, callback });
        }

        try {
            const q = await this.channel.assertQueue(this.queue, { durable: true });
            await this.channel.bindQueue(q.queue, this.exchange, routingKey);
            
            console.log(`[PubSub] Subscribed to ${this.queue} (${routingKey})`);

            this.channel.consume(q.queue, (msg) => {
                if (msg !== null) {
                    try {
                        const content = JSON.parse(msg.content.toString());
                        callback(content);
                        this.channel.ack(msg);
                    } catch (err) {
                        console.error('[PubSub] Message processing error', err);
                        // Optionally nack
                        this.channel.nack(msg, false, false);
                    }
                }
            });
        } catch (error) {
            console.error('[PubSub] Subscribe error:', error);
        }
    }

    async close() {
        if (this.connection) {
            this.explicitClose = true;
            await this.connection.close();
            this.connection = null;
        }
    }
}

module.exports = PubSub;
