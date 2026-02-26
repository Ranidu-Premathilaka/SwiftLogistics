/**
 * Legacy CMS SOAP Service
 *
 * Hosted internally on the container (127.0.0.1 only).
 * All external interaction goes through the CMS Adapter via RabbitMQ.
 *
 * Operations:
 *   CreateOrder       — { orderData, transactionInfo }
 *   UpdateOrderStatus — { orderId, status }
 */
const http   = require('http');
const soap   = require('soap');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { port } = require('./config');
const db     = require('../utility/db');

db.init();

const wsdlXml = fs.readFileSync(path.join(__dirname, 'cms.wsdl'), 'utf8');

// 1️⃣ Define your service (fake implementation)
const cmsService = {
  CMSService: {
    CMSPort: {
      async CreateOrder({ clientId, orderData }) {
        const orderId = `ORD-${crypto.randomUUID()}`;
        console.log('[CMS] CreateOrder called, generated orderId:', orderId);
        await db.query(
            `INSERT INTO orders (order_id, client_id, item_list, status)
             VALUES ($1, $2, $3, 'pending')`,
            [orderId, clientId, JSON.stringify(orderData?.itemList ?? [])]
        );
        console.log(`[CMS] Order stored in DB: orderId=${orderId}, status='pending'`);
        return {
          CreateOrderResponse: { success: true, orderId },
        };
      },

      async UpdateOrderStatus({ orderId, status }) {
        console.log('[CMS] UpdateOrderStatus called:', orderId, status);
        const { rows } = await db.query(
            `UPDATE orders
             SET    status = $1, updated_at = NOW()
             WHERE  order_id = $2
             RETURNING order_id, client_id, item_list, status`,
            [status, orderId]
        );
        const row = rows[0];
        console.log(`[CMS] Order status updated in DB: orderId=${orderId}, status=${status}`);
        const orderData = row
            ? { orderId: row.order_id, clientId: row.client_id, itemList: row.item_list, status: row.status }
            : { orderId, status };
        return {
          UpdateOrderStatusResponse: { success: true, orderData },
        };
      },

      async GetOrdersByUser({ clientId }) {
        console.log('[CMS] GetOrdersByUser called for clientId:', clientId);
        const { rows } = await db.query(
            `SELECT order_id, client_id, item_list, status, created_at, updated_at
             FROM   orders
             WHERE  client_id = $1
             ORDER  BY created_at DESC`,
            [clientId]
        );
        const orders = rows.map(r => {
            // Postgres returns JSONB as a parsed JS value, but SOAP's anyType
            // serialization can collapse a single-item array into a plain object.
            // Normalise itemList to always be an array.
            const raw = r.item_list;
            const itemList = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            return {
            orderId:   r.order_id,
            clientId:  r.client_id,
            itemList,
            status:    r.status,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            };
        });
        console.log(`[CMS] Found ${orders.length} order(s) for clientId=${clientId}`);
        return {
          GetOrdersByUserResponse: { success: true, orders: JSON.stringify(orders) },
        };
      },
    },
  },
};

// 2️⃣ Start HTTP server and attach SOAP service
const server = http.createServer((req, res) => {
  res.statusCode = 404; // fallback
  res.end("Not found");
});

// Bind only to loopback — this service must NOT be reachable outside the container.
// All external interaction goes through the CMS Adapter via RabbitMQ.
server.listen(port, '127.0.0.1', async () => {
  console.log(`[CMS] Legacy SOAP service listening on http://127.0.0.1:${port}/wsdl (internal only)`);
  soap.listen(server, '/wsdl', cmsService, wsdlXml);

  // Start the PubSub adapter once the legacy service is ready.
  const CMSAdapter = require('./cms-adapter');
  const adapter = new CMSAdapter();
  await adapter.start();
});

