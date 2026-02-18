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
 * Fake route-optimization logic.
 * In production this would call a real solver / mapping API.
 */
function optimizeRoute(origin, waypoints) {
  // Simple mock: reverse the waypoints and return a made-up distance/time
  const optimized = [origin, ...[...waypoints].reverse()];

  return {
    optimizedRoute: optimized,
    totalDistance: optimized.length * 12.5, // km (mock)
    estimatedTime: `${optimized.length * 8} mins`, // mock
  };
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
      const { origin, waypoints } = body;

      if (!origin || !Array.isArray(waypoints)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "origin (string) and waypoints (array) are required" })
        );
      }

      console.log("optimize-route called:", origin, waypoints);
      const result = optimizeRoute(origin, waypoints);

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

server.listen(port, () => {
  console.log(`Mock ROS service listening on http://localhost:${port}`);
});