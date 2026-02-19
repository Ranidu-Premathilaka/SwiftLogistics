/**
 * WMS Adapter - Warehouse Management System (PubSub Microservice)
 *
 * This adapter is a self-contained microservice.  It:
 *   1. Receives commands from the rest of the platform via RabbitMQ (PubSub utility).
 *   2. Translates each command into an HTTP call to the locally hosted legacy WMS service
 *      (which is NOT exposed outside the container).
 *   3. Publishes the result back onto the exchange using a reply routing key that carries
 *      the original correlationId so callers can match responses.
 *
 * Routing keys subscribed:
 *   wms.item.stock.check   — { itemId }
 *   wms.item.order         — { itemId, quantity }
 *   wms.item.status.get    — { trackingId }
 *   wms.item.status.update — { trackingId, status }
 *   wms.item.received      — { trackingId, signatureUrl }
 *
 * Reply routing key (publisher):
 *   wms.reply  — { correlationId, success, data?, error? }
 */

const axios   = require('axios');
const PubSub  = require('../../utility/pubsub');
const config  = require('../config');

class WMSAdapter {
    /**
     * @param {object} opts
     * @param {string} opts.legacyUrl  - Base URL of the internal WMS service (default: http://localhost:<port>)
     */
    constructor({ legacyUrl } = {}) {
        this.baseUrl = legacyUrl || `http://localhost:${config.port}`;

        const { url, exchange, queue } = config.rabbitmq;
        this.pubsub = new PubSub(url, exchange, queue);
    }

    // ── Internal helpers to call the legacy WMS HTTP service ─────────────────

    async #itemInStock(itemId) {
        const res = await axios.get(`${this.baseUrl}/stock/${itemId}`);
        return res.data.inStock;
    }

    async #itemOrder(itemId, quantity) {
        const res = await axios.post(`${this.baseUrl}/order`, { itemId, quantity });
        return res.data.trackingId;
    }

    async #itemStatus(trackingId) {
        const res = await axios.get(`${this.baseUrl}/status/${trackingId}`);
        return res.data.status;
    }

    async #updateItemStatus(trackingId, status) {
        await axios.put(`${this.baseUrl}/status/${trackingId}`, { status });
    }

    async #itemReceived(trackingId, signatureUrl) {
        await axios.post(`${this.baseUrl}/received`, { trackingId, signatureUrl });
    }

    // ── Reply helper ──────────────────────────────────────────────────────────

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

    // ── Start the adapter (connect to RabbitMQ and register all handlers) ────

    async start() {
        await this.pubsub.connect();

        const { routingKeys } = config;

        // wms.item.stock.check — { correlationId, itemId }
        await this.pubsub.subscribe(routingKeys.itemInStock, async ({ correlationId, itemId }) => {
            console.log(`[WMSAdapter] itemInStock: itemId=${itemId}`);
            try {
                const inStock = await this.#itemInStock(itemId);
                await this.#reply(correlationId, { inStock });
            } catch (err) {
                console.error('[WMSAdapter] itemInStock error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        // wms.item.order — { correlationId, itemId, quantity }
        await this.pubsub.subscribe(routingKeys.itemOrder, async ({ correlationId, itemId, quantity }) => {
            console.log(`[WMSAdapter] itemOrder: itemId=${itemId}, qty=${quantity}`);
            try {
                const trackingId = await this.#itemOrder(itemId, quantity);
                await this.#reply(correlationId, { trackingId });
            } catch (err) {
                console.error('[WMSAdapter] itemOrder error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        // wms.item.status.get — { correlationId, trackingId }
        await this.pubsub.subscribe(routingKeys.itemStatus, async ({ correlationId, trackingId }) => {
            console.log(`[WMSAdapter] itemStatus: trackingId=${trackingId}`);
            try {
                const status = await this.#itemStatus(trackingId);
                await this.#reply(correlationId, { status });
            } catch (err) {
                console.error('[WMSAdapter] itemStatus error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        // wms.item.status.update — { correlationId, trackingId, status }
        await this.pubsub.subscribe(routingKeys.updateItemStatus, async ({ correlationId, trackingId, status }) => {
            console.log(`[WMSAdapter] updateItemStatus: trackingId=${trackingId}, status=${status}`);
            try {
                await this.#updateItemStatus(trackingId, status);
                await this.#reply(correlationId, { updated: true });
            } catch (err) {
                console.error('[WMSAdapter] updateItemStatus error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        // wms.item.received — { correlationId, trackingId, signatureUrl }
        await this.pubsub.subscribe(routingKeys.itemReceived, async ({ correlationId, trackingId, signatureUrl }) => {
            console.log(`[WMSAdapter] itemReceived: trackingId=${trackingId}`);
            try {
                await this.#itemReceived(trackingId, signatureUrl);
                await this.#reply(correlationId, { received: true });
            } catch (err) {
                console.error('[WMSAdapter] itemReceived error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        console.log('[WMSAdapter] Listening for commands on RabbitMQ.');
    }
}

module.exports = WMSAdapter;