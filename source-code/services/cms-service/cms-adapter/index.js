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
 *   cms.order.create        — { correlationId, clientId, orderData: { itemList, ... } }
 *   cms.order.update_status — { correlationId, orderId, status, itemList }
 *
 * Published routing keys:
 *   order.created   — { correlationId, clientId, orderData: { orderId, itemList, ... } }
 *   order.confirmed — { correlationId, orderId, itemList }
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

    // ── Handlers ──────────────────────────────────────────────────────────────

    async #handleCreateOrder({ correlationId, clientId, orderData }) {
        console.log(`[CMSAdapter] createOrder: correlationId=${correlationId}`);
        try {
            const result  = await this.#sendSOAP('CreateOrder', { clientId, orderData });
            const orderId = result?.CreateOrderResponse?.orderId;
            if (!orderId) throw new Error('CMS did not return an orderId');

            const enrichedOrderData = { ...orderData, orderId };
            await this.pubsub.publish(config.publishedRoutingKeys.orderCreated, {
                correlationId,
                clientId,
                orderData: enrichedOrderData,
            });
            console.log(`[CMSAdapter] Published order.created for orderId=${orderId}`);
        } catch (err) {
            console.error('[CMSAdapter] createOrder error:', err.message);
        }
    }

    async #handleUpdateOrderStatus({ correlationId, orderId, status }) {
        console.log(`[CMSAdapter] updateOrderStatus: orderId=${orderId}, status=${status}`);
        try {
            const result   = await this.#sendSOAP('UpdateOrderStatus', { orderId, status });
            const raw      = result?.UpdateOrderStatusResponse?.orderData ?? {};
            const orderData = {
                orderId:   raw.orderId   ?? orderId,
                status:    raw.status    ?? status,
                itemList:  raw.itemList  ?? [],
            };
            await this.pubsub.publish(config.publishedRoutingKeys.orderStatusUpdated, { correlationId, orderData });
            console.log(`[CMSAdapter] Published order.status_updated for orderId=${orderId}`);
        } catch (err) {
            console.error('[CMSAdapter] updateOrderStatus error:', err.message);
        }
    }

    async #handleGetOrdersByUser({ correlationId, userId }) {
        console.log(`[CMSAdapter] getOrdersByUser: correlationId=${correlationId}, userId=${userId}`);
        try {
            const result    = await this.#sendSOAP('GetOrdersByUser', { clientId: userId });
            const ordersRaw = result?.GetOrdersByUserResponse?.orders ?? '[]';
            const orders    = typeof ordersRaw === 'string' ? JSON.parse(ordersRaw) : ordersRaw;
            await this.pubsub.publish(config.publishedRoutingKeys.orderQueryResponse, {
                correlationId,
                userId,
                orders,
            });
            console.log(`[CMSAdapter] Published order.cms.order_response for userId=${userId}, count=${orders.length}`);
        } catch (err) {
            console.error('[CMSAdapter] getOrdersByUser error:', err.message);
        }
    }

    // ── Start the adapter ─────────────────────────────────────────────────────

    async start() {
        await this.pubsub.connect();
        await this.#initSoap();

        const { subscribedRoutingKeys } = config;

        await this.pubsub.subscribe(subscribedRoutingKeys.createOrder,       this.#handleCreateOrder.bind(this));
        await this.pubsub.subscribe(subscribedRoutingKeys.updateOrderStatus,  this.#handleUpdateOrderStatus.bind(this));
        await this.pubsub.subscribe(subscribedRoutingKeys.getOrdersByUser,    this.#handleGetOrdersByUser.bind(this));

        console.log('[CMSAdapter] Listening for commands on RabbitMQ.');
    }
}

module.exports = CMSAdapter;
