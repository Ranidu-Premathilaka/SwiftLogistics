/**
 * Mock ROS (Route Optimization System) — self-hosted REST service
 *
 * Accepts: JSON POST requests
 * Endpoint: POST /api/ros/optimize-route
 *   Body: { origin: string, waypoints: string[] }
 *   Response: { optimizedRoute: [...], totalDistance: number, estimatedTime: string }
 */

const http = require("http");
const { port } = require("./config");

/**
 * Dummy delivery-path optimizer.
 * Shuffles the supplied { id, location } objects to emulate a "best path" algorithm.
 */
function optimizeRoute(locations) {
  if (!Array.isArray(locations) || locations.length === 0) {
    return { optimizedPath: [] };
  }

  // Fisher-Yates shuffle — mimics a real solver returning an optimal ordering
  const path = [...locations];
  for (let i = path.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [path[i], path[j]] = [path[j], path[i]];
  }

  return { optimizedPath: path };
}

/**
 * Collect the full request body as a string.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // ---------- Health-check (used by the test harness) ----------
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok" }));
  }

  // ---------- Route optimization endpoint ----------
  if (req.method === "POST" && req.url === "/api/ros/optimize-route") {
    try {
      const body = JSON.parse(await readBody(req));
      const { locations } = body;

      if (!Array.isArray(locations)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "locations (array of { id, location } objects) is required" })
        );
      }

      console.log("optimize-route called, locations:", locations);
      const result = optimizeRoute(locations);

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
  }

  // ---------- Fallback ----------
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// Bind only to loopback — this service must NOT be reachable outside the container.
// All external interaction goes through the ROS Adapter via RabbitMQ.
server.listen(port, '127.0.0.1', async () => {
  console.log(`[ros] Legacy ROS service listening on http://127.0.0.1:${port} (internal only)`);

  // Start the PubSub adapter once the legacy service is ready.
  const ROSAdapter = require('./ros-adapter');
  const adapter = new ROSAdapter();
  await adapter.start();
});