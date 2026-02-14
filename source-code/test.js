const path = require("path");
const http = require("http");
const assert = require("assert/strict");
const { spawn } = require("child_process");

// Conditionally load adapters (not every branch has all of them)
let CMSAdapter, ROSAdapter, WMSAdapter;
try { CMSAdapter = require("./adapters/cms-adapter"); } catch { CMSAdapter = null; }
try { ROSAdapter = require("./adapters/ros-adapter"); } catch { ROSAdapter = null; }
try { WMSAdapter = require("./adapters/wms-adapter"); } catch { WMSAdapter = null; }

const CMS_SERVER_URL = "http://localhost";
const CMS_SERVER_PORT = 8000;
const WSDL_URL = `${CMS_SERVER_URL}:${CMS_SERVER_PORT}/wsdl?wsdl`;

const ROS_PORT = 9000;
const ROS_HEALTH_URL = `http://localhost:${ROS_PORT}/health`;

const WMS_PORT = 7000;
const WMS_HEALTH_URL = `http://localhost:${WMS_PORT}/health`;

function isSoapTrue(value) {
	return value === true || value === "true" || value === 1 || value === "1";
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttpOk(url, { timeoutMs = 8000, intervalMs = 250 } = {}) {
	const start = Date.now();
	const urlObj = new URL(url);

	while (Date.now() - start < timeoutMs) {
		const ok = await new Promise((resolve) => {
			const req = http.request(
				{
					method: "GET",
					hostname: urlObj.hostname,
					port: urlObj.port,
					path: urlObj.pathname + urlObj.search,
					timeout: 1000,
				},
				(res) => {
					res.resume();
					resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 300);
				}
			);
			req.on("timeout", () => {
				req.destroy();
				resolve(false);
			});
			req.on("error", () => resolve(false));
			req.end();
		});

		if (ok) return;
		await delay(intervalMs);
	}

	throw new Error(`Timed out waiting for server to be ready at ${url}`);
}

function startMockCMSServer() {
	const serverEntry = path.join(__dirname, "sub-systems", "cms", "index.js");

	const child = spawn(process.execPath, [serverEntry], {
		stdio: "inherit",
		windowsHide: true,
	});

	return child;
}

function startMockROSServer() {
	const serverEntry = path.join(__dirname, "sub-systems", "rms", "index.js");
	return spawn(process.execPath, [serverEntry], { stdio: "inherit", windowsHide: true });
}

function startMockWMSServer() {
	const serverEntry = path.join(__dirname, "sub-systems", "wms", "index.js");
	return spawn(process.execPath, [serverEntry], { stdio: "inherit", windowsHide: true });
}

async function stopChildProcess(child) {
	if (!child || child.killed) return;

	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => child.once("exit", resolve)),
		delay(1500),
	]);

	if (!child.killed) {
		child.kill("SIGKILL");
	}
}

(async () => {
	let cmsProcess;
	let rosProcess;
	let wmsProcess;
	try {
		// ─── CMS Adapter Tests ─────────────────────────────────
		if (CMSAdapter) {
			console.log("Starting mock CMS SOAP server...");
			cmsProcess = startMockCMSServer();
			await waitForHttpOk(WSDL_URL);
			console.log("Mock CMS is up:", WSDL_URL);

			const cmsAdapter = new CMSAdapter({ url: CMS_SERVER_URL, port: CMS_SERVER_PORT });
			await cmsAdapter.init();

			console.log("Testing AuthenticateClient...");
			const auth = await cmsAdapter.clientAuthenticate("client-1", "secret-1");
			assert.ok(isSoapTrue(auth.success));
			assert.equal(typeof auth.token, "string");

			console.log("Testing GetClientOrders...");
			const orders = await cmsAdapter.getClientOrderID("client-1");
			assert.ok(Array.isArray(orders));
			assert.ok(orders.length >= 1);
			assert.ok(orders[0].orderId);

			console.log("Testing GetOrderInfo...");
			const orderInfo = await cmsAdapter.getOrderInfo("order1");
			console.log("  ↳ orderInfo:", JSON.stringify(orderInfo, null, 2));
			assert.equal(orderInfo.orderId, "order1");

			console.log("Testing CreateOrder...");
			const createOk = await cmsAdapter.createOrder(
				{ items: [{ productId: "p1", qty: 1 }], notes: "test" },
				{ paymentMethod: "card", amount: 100 }
			);
			assert.ok(isSoapTrue(createOk));

			console.log("Testing UpdateOrder...");
			const updated = await cmsAdapter.updateOrder("order1", { status: "shipped" });
			assert.equal(updated.orderId, "order1");
			assert.equal(updated.status, "shipped");

			console.log("Testing DeleteOrder...");
			const deleteOk = await cmsAdapter.deleteOrder("order2");
			assert.ok(isSoapTrue(deleteOk));

			console.log("\n✓ All CMS adapter tests passed.\n");
		} else {
			console.log("⏭  CMS adapter not found on this branch — skipping CMS tests.\n");
		}

		// ─── ROS Adapter Tests ─────────────────────────────────
		if (ROSAdapter) {
			console.log("Starting mock ROS server...");
			rosProcess = startMockROSServer();
			await waitForHttpOk(ROS_HEALTH_URL);
			console.log("Mock ROS is up:", ROS_HEALTH_URL);

			const rosAdapter = new ROSAdapter();

			console.log("Testing getOptimalRoute...");
			const routeResult = await rosAdapter.getOptimalRoute("Colombo", [
				"Kandy",
				"Galle",
				"Jaffna",
			]);
			console.log("  ↳ routeResult:", JSON.stringify(routeResult, null, 2));
			assert.ok(routeResult.optimizedRoute, "optimizedRoute should exist");
			assert.ok(Array.isArray(routeResult.optimizedRoute), "optimizedRoute should be an array");
			assert.ok(routeResult.optimizedRoute.length >= 1, "optimizedRoute should have entries");
			assert.equal(routeResult.optimizedRoute[0], "Colombo", "first stop should be the origin");
			assert.ok(routeResult.totalDistance > 0, "totalDistance should be positive");
			assert.ok(typeof routeResult.estimatedTime === "string", "estimatedTime should be a string");

			console.log("\n✓ All ROS adapter tests passed.\n");
		} else {
			console.log("⏭  ROS adapter not found on this branch — skipping ROS tests.\n");
		}

		// ─── WMS Adapter Tests ─────────────────────────────────
		if (WMSAdapter) {
			console.log("Starting mock WMS server...");
			wmsProcess = startMockWMSServer();
			await waitForHttpOk(WMS_HEALTH_URL);
			console.log("Mock WMS is up:", WMS_HEALTH_URL);

			const wmsAdapter = new WMSAdapter({ url: "localhost", port: WMS_PORT });

			console.log("Testing itemInStock (in-stock item)...");
			const inStock = await wmsAdapter.itemInStock("item-001");
			console.log("  ↳ inStock:", inStock);
			assert.equal(inStock, true, "item-001 should be in stock");

			console.log("Testing itemInStock (out-of-stock item)...");
			const outOfStock = await wmsAdapter.itemInStock("item-002");
			console.log("  ↳ inStock:", outOfStock);
			assert.equal(outOfStock, false, "item-002 should be out of stock");

			console.log("Testing itemOrder...");
			const trackingId = await wmsAdapter.itemOrder("item-001", 5);
			console.log("  ↳ trackingId:", trackingId);
			assert.ok(typeof trackingId === "string", "trackingId should be a string");
			assert.ok(trackingId.startsWith("trk-"), "trackingId should start with trk-");

			console.log("Testing itemStatus...");
			const status = await wmsAdapter.itemStatus(trackingId);
			console.log("  ↳ status:", status);
			assert.equal(status, "reserved", "initial status should be 'reserved'");

			console.log("Testing updateItemStatus...");
			await wmsAdapter.updateItemStatus(trackingId, "picked");
			const updatedStatus = await wmsAdapter.itemStatus(trackingId);
			console.log("  ↳ status after update:", updatedStatus);
			assert.equal(updatedStatus, "picked", "status should be 'picked' after update");

			console.log("Testing itemReceived...");
			await wmsAdapter.itemReceived(trackingId, "https://example.com/sig.png");
			const receivedStatus = await wmsAdapter.itemStatus(trackingId);
			console.log("  ↳ status after received:", receivedStatus);
			assert.equal(receivedStatus, "received", "status should be 'received' after itemReceived");

			console.log("\n✓ All WMS adapter tests passed.\n");
		} else {
			console.log("⏭  WMS adapter not found on this branch — skipping WMS tests.\n");
		}

		console.log("════════════════════════════════════════");
		console.log("  All adapter smoke tests passed.");
		console.log("════════════════════════════════════════");
	} catch (err) {
		console.error("\nAdapter smoke tests failed:");
		console.error(err);
		process.exitCode = 1;
	} finally {
		await stopChildProcess(cmsProcess);
		await stopChildProcess(rosProcess);
		await stopChildProcess(wmsProcess);
	}
})();
