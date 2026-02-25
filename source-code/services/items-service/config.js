// Items Service Configuration

module.exports = {

    port: process.env.PORT || 3000,

    rabbitmq: {
        url:      process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq-service:5672',
        exchange: 'swift_logistics',
        queue:    'items-service-queue',
    },

    publishedRoutingKeys: {
        // { correlationId } — request inventory list from WMS
        wmsItemsRequest: 'wms.items.request',
        notifyClientItemsResponse: 'notify.client.items_response',
    },

    subscribedRoutingKeys: {
        // {items: [{ itemId, name, stock }] }
        wmsItemsResponse: 'wms.items.response',
    },
};
