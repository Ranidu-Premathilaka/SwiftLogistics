/**
 * Mock WMS (Warehouse Management System) — self-hosted REST service
 *
 * Accepts: JSON requests
 * Endpoints:
 *   GET  /health                  — health-check
 *   GET  /stock/:itemId           — check stock
 *   POST /order                   — reserve item, returns trackingId
 *   GET  /status/:trackingId      — get reservation status
 *   PUT  /status/:trackingId      — update reservation status
 *   POST /received                — mark item as received
 */

const http = require("http");
const crypto = require("crypto");

const { port } = require("./config");

// ── In-memory mock data ────────────────────────────────────────
const stockLevels = {
  "item-001": 50,
  "item-002": 0,
  "item-003": 12,
};

const reservations = {}; // trackingId → { itemId, quantity, status }

// ── Helpers ────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function matchRoute(method, url, expectedMethod, pattern) {
  if (method !== expectedMethod) return null;
  const match = url.match(pattern);
  return match;
}

// ── Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  let m;

  // Health-check
  if (method === "GET" && url === "/health") {
    return json(res, 200, { status: "ok" });
  }

  // GET /stock/:itemId
  if ((m = matchRoute(method, url, "GET", /^\/stock\/([^/]+)$/))) {
    const itemId = m[1];
    const qty = stockLevels[itemId];
    const inStock = qty !== undefined && qty > 0;
    console.log(`stock check — ${itemId}: inStock=${inStock} (qty=${qty ?? "unknown"})`);
    return json(res, 200, { itemId, inStock, quantity: qty ?? 0 });
  }

  // POST /order  { itemId, quantity }
  if (method === "POST" && url === "/order") {
    try {
      const body = JSON.parse(await readBody(req));
      const { itemId, quantity } = body;
      if (!itemId || quantity == null) {
        return json(res, 400, { error: "itemId and quantity are required" });
      }
      const trackingId = "trk-" + crypto.randomBytes(6).toString("hex");
      reservations[trackingId] = { itemId, quantity, status: "reserved" };
      console.log(`order created — ${trackingId} (${itemId} x${quantity})`);
      return json(res, 201, { trackingId });
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }
  }

  // GET /status/:trackingId
  if ((m = matchRoute(method, url, "GET", /^\/status\/([^/]+)$/))) {
    const trackingId = m[1];
    const reservation = reservations[trackingId];
    if (!reservation) {
      return json(res, 404, { error: "Tracking ID not found" });
    }
    console.log(`status query — ${trackingId}: ${reservation.status}`);
    return json(res, 200, { trackingId, status: reservation.status });
  }

  // PUT /status/:trackingId  { status }
  if ((m = matchRoute(method, url, "PUT", /^\/status\/([^/]+)$/))) {
    try {
      const trackingId = m[1];
      const reservation = reservations[trackingId];
      if (!reservation) {
        return json(res, 404, { error: "Tracking ID not found" });
      }
      const body = JSON.parse(await readBody(req));
      reservation.status = body.status;
      console.log(`status update — ${trackingId}: ${reservation.status}`);
      return json(res, 200, { trackingId, status: reservation.status });
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }
  }

  // POST /received  { trackingId, signatureUrl }
  if (method === "POST" && url === "/received") {
    try {
      const body = JSON.parse(await readBody(req));
      const { trackingId, signatureUrl } = body;
      if (!trackingId) {
        return json(res, 400, { error: "trackingId is required" });
      }
      const reservation = reservations[trackingId];
      if (!reservation) {
        return json(res, 404, { error: "Tracking ID not found" });
      }
      reservation.status = "received";
      reservation.signatureUrl = signatureUrl;
      console.log(`item received — ${trackingId} (signature: ${signatureUrl})`);
      return json(res, 200, { trackingId, status: "received" });
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }
  }

  // Fallback
  json(res, 404, { error: "Not found" });
});

// Bind only to loopback — this service must NOT be reachable outside the container.
// All external interaction goes through the WMS Adapter via RabbitMQ.
server.listen(port, '127.0.0.1', async () => {
  console.log(`[WMS] Legacy service listening on http://127.0.0.1:${port} (internal only)`);

  // Start the PubSub adapter once the legacy service is ready.
  const WMSAdapter = require('./wms-adapter');
  const adapter = new WMSAdapter();
  await adapter.start();
});