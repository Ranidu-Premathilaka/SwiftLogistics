/**
 * CMS Adapter - Client Management System (PubSub Microservice)
 *
 * This adapter is a self-contained microservice.  It:
 *   1. Receives commands from the rest of the platform via RabbitMQ (PubSub utility).
 *   2. Translates each command into a SOAP call to the locally hosted legacy CMS service
 *      (which is NOT exposed outside the container).
 *   3. Publishes the result back onto the exchange using a reply routing key that carries
 *      the original correlationId so callers can match responses.
 *
 * Routing keys subscribed:
 *   cms.client.orders.get   — { clientId }
 *   cms.order.info.get      — { orderId }
 *   cms.order.create        — { orderData, transactionInfo }
 *   cms.order.update        — { orderId, updateData }
 *   cms.order.delete        — { orderId }
 *
 * Reply routing key (publisher):
 *   cms.reply  — { correlationId, success, data?, error? }
 */

const soap    = require('soap');
const PubSub  = require('../../utility/pubsub');
const config  = require('../config');

class CMSAdapter {
    constructor({ legacyUrl } = {}) {
        this.baseUrl    = legacyUrl || `http://${config.host}:${config.port}`;
        this.soapClient = null;

        const { url, exchange, queue } = config.rabbitmq;
        this.pubsub = new PubSub(url, exchange, queue);
    }

    // ── Internal: initialise the SOAP client against the local legacy service ─

    async #initSoap() {
        this.soapClient = await soap.createClientAsync(`${this.baseUrl}/wsdl?wsdl`);
        this.soapClient.setEndpoint(`${this.baseUrl}/wsdl`);
        console.log('[CMSAdapter] SOAP client initialised.');
    }

    async #sendSOAP(action, args) {
        if (!this.soapClient) throw new Error('SOAP client not initialised');
        const methodName = action + 'Async';
        if (typeof this.soapClient[methodName] !== 'function') {
            throw new Error(`SOAP method ${methodName} not found in WSDL`);
        }
        const [result] = await this.soapClient[methodName](args);
        return result;
    }

    // ── Reply helpers ─────────────────────────────────────────────────────────

    async #reply(correlationId, data) {
        await this.pubsub.publish(config.replyRoutingKey, { correlationId, success: true, data });
    }

    async #replyError(correlationId, error) {
        await this.pubsub.publish(config.replyRoutingKey, {
            correlationId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    // ── Start the adapter ─────────────────────────────────────────────────────

    async start() {
        await this.pubsub.connect();
        await this.#initSoap();

        const { routingKeys } = config;

        // cms.client.orders.get — { correlationId, clientId }
        await this.pubsub.subscribe(routingKeys.getClientOrders, async ({ correlationId, clientId }) => {
            console.log(`[CMSAdapter] getClientOrders: clientId=${clientId}`);
            try {
                const res = await this.#sendSOAP('GetClientOrders', { clientId });
                await this.#reply(correlationId, res.GetClientOrdersResponse.orders);
            } catch (err) {
                console.error('[CMSAdapter] getClientOrders error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        // cms.order.info.get — { correlationId, orderId }
        await this.pubsub.subscribe(routingKeys.getOrderInfo, async ({ correlationId, orderId }) => {
            console.log(`[CMSAdapter] getOrderInfo: orderId=${orderId}`);
            try {
                const res = await this.#sendSOAP('GetOrderInfo', { orderId });
                await this.#reply(correlationId, res.GetOrderInfoResponse.order);
            } catch (err) {
                console.error('[CMSAdapter] getOrderInfo error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        // cms.order.create — { correlationId, orderData, transactionInfo }
        await this.pubsub.subscribe(routingKeys.createOrder, async ({ correlationId, orderData, transactionInfo }) => {
            console.log('[CMSAdapter] createOrder');
            try {
                const res = await this.#sendSOAP('CreateOrder', { orderData, transactionInfo });
                await this.#reply(correlationId, { success: res.CreateOrderResponse.success });
            } catch (err) {
                console.error('[CMSAdapter] createOrder error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        // cms.order.update — { correlationId, orderId, updateData }
        await this.pubsub.subscribe(routingKeys.updateOrder, async ({ correlationId, orderId, updateData }) => {
            console.log(`[CMSAdapter] updateOrder: orderId=${orderId}`);
            try {
                const res = await this.#sendSOAP('UpdateOrder', { orderId, updateData });
                await this.#reply(correlationId, res.UpdateOrderResponse.updatedOrder);
            } catch (err) {
                console.error('[CMSAdapter] updateOrder error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        // cms.order.delete — { correlationId, orderId }
        await this.pubsub.subscribe(routingKeys.deleteOrder, async ({ correlationId, orderId }) => {
            console.log(`[CMSAdapter] deleteOrder: orderId=${orderId}`);
            try {
                const res = await this.#sendSOAP('DeleteOrder', { orderId });
                await this.#reply(correlationId, { success: res.DeleteOrderResponse.success });
            } catch (err) {
                console.error('[CMSAdapter] deleteOrder error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        console.log('[CMSAdapter] Listening for commands on RabbitMQ.');
    }
}

module.exports = CMSAdapter;
