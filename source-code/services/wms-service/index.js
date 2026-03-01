/**
 * Legacy WMS (Warehouse Management System) — self-hosted REST service
 *
 * Hosted internally on the container (127.0.0.1 only).
 * All external interaction goes through the WMS Adapter via RabbitMQ.
 *
 * Endpoints:
 *   GET  /api/wms/items    — returns available inventory
 *   POST /api/wms/reserve  — { orderId, itemList: [{ itemId, quantity }] } → { success, reservationId }
 *   POST /api/wms/release  — { orderId } → { success }
 */

const http = require('http');
const { port } = require('./config');

// ── Mock inventory ────────────────────────────────────────────────────────
// stock = currently available units (already accounts for active reservations)
const inventory = new Map([
    ['item-001', { name: 'Laptop',      stock: 50,  price: 999.99  }],
    ['item-002', { name: 'Phone',       stock: 100, price: 699.99  }],
    ['item-003', { name: 'Tablet',      stock: 30,  price: 449.99  }],
    ['item-004', { name: 'Headphones',  stock: 200, price: 149.99  }],
    ['item-005', { name: 'Monitor',     stock: 20,  price: 349.99  }],
]);

// orderId → Map<itemId, quantity>  (so release can restore exact amounts)
const reservations = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  // ── List available items ────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/wms/items') {
    const items = Array.from(inventory.entries()).map(([itemId, item]) => ({
      itemId,
      name:  item.name,
      stock: item.stock,
      price: item.price,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ items }));
  }

  // ── Reserve items for an order ──────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/wms/reserve') {
    try {
      const body = JSON.parse(await readBody(req));
      const { orderId, itemList } = body;

      if (!orderId || !Array.isArray(itemList) || itemList.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'orderId and itemList (array) are required' }));
      }

      // ── Availability check (all-or-nothing) ──────────────────────────
      for (const { itemId, quantity } of itemList) {
        const item = inventory.get(itemId);
        if (!item) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Unknown item: ${itemId}` }));
        }
        if (item.stock < quantity) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: `Insufficient stock for ${itemId}: requested ${quantity}, available ${item.stock}` }));
        }
      }

      // ── Deduct stock and record reservation ──────────────────────────
      const reserved = new Map();
      for (const { itemId, quantity } of itemList) {
        inventory.get(itemId).stock -= quantity;
        reserved.set(itemId, quantity);
      }
      reservations.set(String(orderId), { items: reserved, deliveryStatus: null });

      const reservationId = `RES-${orderId}-${Date.now()}`;
      console.log(`[WMS] Reserved: orderId=${orderId}, reservationId=${reservationId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, reservationId }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
  }

  // ── Release a reservation (restore stock) ──────────────────────────────
  if (req.method === 'POST' && req.url === '/api/wms/release') {
    try {
      const body = JSON.parse(await readBody(req));
      const { orderId } = body;

      if (!orderId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'orderId is required' }));
      }

      const reservation = reservations.get(String(orderId));
      if (reservation) {
        for (const [itemId, quantity] of reservation.items) {
          const item = inventory.get(itemId);
          if (item) item.stock += quantity;
        }
        reservations.delete(String(orderId));
        console.log(`[WMS] Released reservation and restored stock for orderId=${orderId}`);
      } else {
        console.warn(`[WMS] No reservation found for orderId=${orderId} (may have already been released)`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
  }

  // ── Update delivery status for a reservation ──────────────────────────
  if (req.method === 'PATCH' && req.url === '/api/wms/delivery-status') {
    try {
      const body = JSON.parse(await readBody(req));
      const { orderId, deliveryStatus } = body;
      if (!orderId || !deliveryStatus) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'orderId and deliveryStatus are required' }));
      }
      const reservation = reservations.get(String(orderId));
      if (!reservation) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: `No reservation found for orderId: ${orderId}` }));
      }
      reservation.deliveryStatus = deliveryStatus;
      console.log(`[WMS] deliveryStatus updated: orderId=${orderId}, deliveryStatus=${deliveryStatus}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Bind only to loopback — this service must NOT be reachable outside the container.
// All external interaction goes through the WMS Adapter via RabbitMQ.
server.listen(port, '127.0.0.1', async () => {
  console.log(`[WMS] Legacy WMS service listening on http://127.0.0.1:${port} (internal only)`);

  // Start the PubSub adapter once the legacy service is ready.
  const WMSAdapter = require('./wms-adapter');
  const adapter = new WMSAdapter();
  await adapter.start();
});
