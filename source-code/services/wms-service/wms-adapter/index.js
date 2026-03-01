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
 *   order.confirmed    — { correlationId, orderId, itemList: [{ itemId, quantity }] }
 *   wms.order.release  — { correlationId, orderId }
 *   wms.items.request  — { correlationId }
 *
 * Published routing keys:
 *   order.wms.reserved           — { correlationId, orderId, reservationId }
 *   order.wms.reservation_failed — { correlationId, orderId, error }
 *   wms.items.response           — { correlationId, items: [{ itemId, name, stock }] }
 */

const axios  = require('axios');
const PubSub = require('../../utility/pubsub');
const config = require('../config');

class WMSAdapter {
    constructor({ legacyUrl } = {}) {
        this.baseUrl = (legacyUrl || `http://127.0.0.1:${config.port}`) + '/api/wms';

        const { url, exchange, queue } = config.rabbitmq;
        this.pubsub = new PubSub(url, exchange, queue);
    }

    // ── Internal: call the legacy WMS HTTP service ────────────────────────────

    async #getItems() {
        const res = await axios.get(`${this.baseUrl}/items`);
        return res.data.items;
    }

    async #reserve(orderId, itemList) {
        const res = await axios.post(`${this.baseUrl}/reserve`, { orderId, itemList });
        return res.data;
    }

    async #release(orderId) {
        const res = await axios.post(`${this.baseUrl}/release`, { orderId });
        return res.data;
    }

    async #updateDeliveryStatus(orderId, deliveryStatus) {
        const res = await axios.patch(`${this.baseUrl}/delivery-status`, { orderId, deliveryStatus });
        return res.data;
    }

    async #getDeliveryStatus(orderId) {
        const res = await axios.get(`${this.baseUrl}/delivery-status`, { params: { orderId } });
        return res.data;
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    async #handleItemsRequest({ correlationId }) {
        console.log(`[WMSAdapter] handleItemsRequest: correlationId=${correlationId}`);
        try {
            const items = await this.#getItems();
            await this.pubsub.publish(config.publishedRoutingKeys.wmsItemsResponse, {
                correlationId,
                items,
            });
        } catch (err) {
            console.error('[WMSAdapter] items request error:', err.message);
            await this.pubsub.publish(config.publishedRoutingKeys.wmsItemsResponse, {
                correlationId,
                items: [],
                error: err.message,
            });
        }
    }

    async #handleOrderConfirmed({ correlationId, orderId, itemList }) {
        console.log(`[WMSAdapter] handleOrderConfirmed: orderId=${orderId}`);
        if (!Array.isArray(itemList) || itemList.length === 0) {
            console.error(`[WMSAdapter] handleOrderConfirmed: itemList is missing or empty for orderId=${orderId}`);
            await this.pubsub.publish(config.publishedRoutingKeys.wmsReservationFailed, {
                correlationId,
                orderId,
                error: 'itemList is required for reservation',
            });
            return;
        }
        try {
            const result = await this.#reserve(orderId, itemList);
            if (!result.success) {
                await this.pubsub.publish(config.publishedRoutingKeys.wmsReservationFailed, {
                    correlationId,
                    orderId,
                    error: result.error || 'Reservation failed',
                });
                console.warn(`[WMSAdapter] WMS rejected reservation for orderId=${orderId}: ${result.error}`);
                return;
            }
            await this.pubsub.publish(config.publishedRoutingKeys.wmsReserved, {
                correlationId,
                orderId,
                reservationId: result.reservationId,
            });
            console.log(`[WMSAdapter] Reserved orderId=${orderId}, reservationId=${result.reservationId}`);
        } catch (err) {
            console.error(`[WMSAdapter] reserve error for orderId=${orderId}:`, err.message);
            await this.pubsub.publish(config.publishedRoutingKeys.wmsReservationFailed, {
                correlationId,
                orderId,
                error: err.message,
            });
        }
    }

    async #handleReleaseReservation({ correlationId, orderId }) {
        console.log(`[WMSAdapter] handleReleaseReservation: orderId=${orderId}`);
        try {
            await this.#release(orderId);
            console.log(`[WMSAdapter] Reservation released for orderId=${orderId}`);
        } catch (err) {
            // Best-effort release — log but do not bubble
            console.error(`[WMSAdapter] release error for orderId=${orderId}:`, err.message);
        }
    }

    async #handleUpdateDeliveryStatus({ correlationId, orderId, deliveryStatus }) {
        console.log(`[WMSAdapter] handleUpdateDeliveryStatus: orderId=${orderId}, deliveryStatus=${deliveryStatus}`);
        try {
            const result = await this.#updateDeliveryStatus(orderId, deliveryStatus);
            if (!result.success) {
                console.warn(`[WMSAdapter] deliveryStatus update failed for orderId=${orderId}: ${result.error}`);
                return;
            }
            await this.pubsub.publish(config.publishedRoutingKeys.deliveryStatusUpdated, {
                correlationId,
                orderId,
                deliveryStatus,
            });
            console.log(`[WMSAdapter] Published wms.delivery.status_updated for orderId=${orderId}, deliveryStatus=${deliveryStatus}`);
        } catch (err) {
            console.error(`[WMSAdapter] updateDeliveryStatus error for orderId=${orderId}:`, err.message);
        }
    }

    async #handleStatusRequest({ correlationId, orderId }) {
        console.log(`[WMSAdapter] handleStatusRequest: orderId=${orderId}`);
        try {
            const result = await this.#getDeliveryStatus(orderId);
            await this.pubsub.publish(config.publishedRoutingKeys.statusResponse, {
                correlationId,
                orderId,
                deliveryStatus: result.deliveryStatus ?? null,
            });
            console.log(`[WMSAdapter] Published wms.delivery.status_response for orderId=${orderId}, deliveryStatus=${result.deliveryStatus}`);
        } catch (err) {
            const status = err.response?.status;
            console.warn(`[WMSAdapter] statusRequest error for orderId=${orderId} (HTTP ${status ?? 'N/A'}): ${err.message}`);
            await this.pubsub.publish(config.publishedRoutingKeys.statusResponse, {
                correlationId,
                orderId,
                deliveryStatus: null,
                error: status === 404 ? 'No reservation found for this order' : err.message,
            });
        }
    }

    // ── Start the adapter ─────────────────────────────────────────────────────

    async start() {
        await this.pubsub.connect();

        await this.pubsub.subscribe(
            config.subscribedRoutingKeys.orderConfirmed,
            this.#handleOrderConfirmed.bind(this),
        );

        await this.pubsub.subscribe(
            config.subscribedRoutingKeys.releaseReservation,
            this.#handleReleaseReservation.bind(this),
        );
        await this.pubsub.subscribe(
            config.subscribedRoutingKeys.itemsRequest,
            this.#handleItemsRequest.bind(this),
        );
        await this.pubsub.subscribe(
            config.subscribedRoutingKeys.updateDeliveryStatus,
            this.#handleUpdateDeliveryStatus.bind(this),
        );
        await this.pubsub.subscribe(
            config.subscribedRoutingKeys.statusRequest,
            this.#handleStatusRequest.bind(this),
        );
        console.log('[WMSAdapter] Listening for commands on RabbitMQ.');
    }
}

module.exports = WMSAdapter;
