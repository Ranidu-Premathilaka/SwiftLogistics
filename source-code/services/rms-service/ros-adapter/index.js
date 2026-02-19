/**
 * ROS Adapter - Route Optimization System (PubSub Microservice)
 *
 * This adapter is a self-contained microservice.  It:
 *   1. Receives commands from the rest of the platform via RabbitMQ (PubSub utility).
 *   2. Translates each command into an HTTP call to the locally hosted legacy ROS service
 *      (which is NOT exposed outside the container).
 *   3. Publishes the result back onto the exchange using a reply routing key that carries
 *      the original correlationId so callers can match responses.
 *
 * Routing keys subscribed:
 *   rms.route.optimize — { origin, waypoints }
 *
 * Reply routing key (publisher):
 *   rms.reply  — { correlationId, success, data?, error? }
 */

const axios   = require('axios');
const PubSub  = require('../../utility/pubsub');
const config  = require('../config');

class ROSAdapter {
    constructor({ legacyUrl } = {}) {
        this.baseUrl = (legacyUrl || `http://localhost:${config.port}`) + '/api/ros';

        const { url, exchange, queue } = config.rabbitmq;
        this.pubsub = new PubSub(url, exchange, queue);
    }

    // ── Internal: call the legacy ROS HTTP service ────────────────────────────

    async #optimizeRoute(origin, waypoints) {
        const res = await axios.post(`${this.baseUrl}/optimize-route`, { origin, waypoints });
        return res.data;
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

        const { routingKeys } = config;

        // rms.route.optimize — { correlationId, origin, waypoints }
        await this.pubsub.subscribe(routingKeys.optimizeRoute, async ({ correlationId, origin, waypoints }) => {
            console.log(`[ROSAdapter] optimizeRoute: origin=${origin}, waypoints=${JSON.stringify(waypoints)}`);
            try {
                const result = await this.#optimizeRoute(origin, waypoints);
                await this.#reply(correlationId, result);
            } catch (err) {
                console.error('[ROSAdapter] optimizeRoute error:', err.message);
                await this.#replyError(correlationId, err);
            }
        });

        console.log('[ROSAdapter] Listening for commands on RabbitMQ.');
    }
}

module.exports = ROSAdapter;
