const path = require("path");
const http = require("http");
const assert = require("assert/strict");
const { spawn } = require("child_process");

const CMSAdapter = require("./adapters/cms-adapter");

const SERVER_URL = "http://localhost";
const SERVER_PORT = 8000;
const WSDL_URL = `${SERVER_URL}:${SERVER_PORT}/wsdl?wsdl`;

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
	let serverProcess;
	try {
		console.log("Starting mock CMS SOAP server...");
		serverProcess = startMockCMSServer();
		await waitForHttpOk(WSDL_URL);
		console.log("Mock CMS is up:", WSDL_URL);

		const adapter = new CMSAdapter({ url: SERVER_URL, port: SERVER_PORT });
		await adapter.init();

		console.log("Testing AuthenticateClient...");
		const auth = await adapter.clientAuthenticate("client-1", "secret-1");
		assert.ok(isSoapTrue(auth.success));
		assert.equal(typeof auth.token, "string");

		console.log("Testing GetClientOrders...");
		const orders = await adapter.getClientOrderID("client-1");
		assert.ok(Array.isArray(orders));
		assert.ok(orders.length >= 1);
		assert.ok(orders[0].orderId);

		console.log("Testing GetOrderInfo...");
		const orderInfo = await adapter.getOrderInfo("order1");
		console.log("  ↳ orderInfo:", JSON.stringify(orderInfo, null, 2));
		assert.equal(orderInfo.orderId, "order1");
		// NOTE: node-soap with xsd:anyType + RPC style may not preserve nested
		// arrays/objects faithfully. We only assert the orderId was returned
		// correctly; the full payload fidelity depends on a proper XSD schema.

		console.log("Testing CreateOrder...");
		const createOk = await adapter.createOrder(
			{ items: [{ productId: "p1", qty: 1 }], notes: "test" },
			{ paymentMethod: "card", amount: 100 }
		);
		assert.ok(isSoapTrue(createOk));

		console.log("Testing UpdateOrder...");
		const updated = await adapter.updateOrder("order1", { status: "shipped" });
		assert.equal(updated.orderId, "order1");
		assert.equal(updated.status, "shipped");

		console.log("Testing DeleteOrder...");
		const deleteOk = await adapter.deleteOrder("order2");
		assert.ok(isSoapTrue(deleteOk));

		console.log("\nAll adapter smoke tests passed.");
	} catch (err) {
		console.error("\nAdapter smoke tests failed:");
		console.error(err);
		process.exitCode = 1;
	} finally {
		await stopChildProcess(serverProcess);
	}
})();
