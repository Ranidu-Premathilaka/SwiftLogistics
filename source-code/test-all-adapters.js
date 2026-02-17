const CMSAdapter = require("./adapters/cms-adapter");
const ROSAdapter = require("./adapters/ros-adapter");
const WMSAdapter = require("./adapters/wms-adapter");

(async () => {
  // Test CMS Adapter
  const cms = new CMSAdapter({ url: "http://localhost", port: 3001 });
  await cms.init();
  console.log("\n--- CMSAdapter ---");
  try {
    const auth = await cms.clientAuthenticate("client-123", "secret");
    console.log("clientAuthenticate:", auth);
    const orders = await cms.getClientOrderID("client-123");
    console.log("getClientOrderID:", orders);
    const orderInfo = await cms.getOrderInfo("order1");
    console.log("getOrderInfo:", orderInfo);
    const create = await cms.createOrder({ item: "item-001", qty: 2 }, { payment: "paid" });
    console.log("createOrder:", create);
    const update = await cms.updateOrder("order1", { status: "updated" });
    console.log("updateOrder:", update);
    const del = await cms.deleteOrder("order1");
    console.log("deleteOrder:", del);
  } catch (err) {
    console.error("CMSAdapter error:", err);
  }

  // Test ROS Adapter
  const ros = new ROSAdapter({ url: "localhost", port: 3002 });
  console.log("\n--- ROSAdapter ---");
  try {
    const route = await ros.getOptimalRoute("A", ["B", "C", "D"]);
    console.log("getOptimalRoute:", route);
  } catch (err) {
    console.error("ROSAdapter error:", err);
  }

  // Test WMS Adapter
  const wms = new WMSAdapter({ url: "localhost", port: 3003 });
  console.log("\n--- WMSAdapter ---");
  try {
    const inStock = await wms.itemInStock("item-001");
    console.log("itemInStock:", inStock);
    const trackingId = await wms.itemOrder("item-001", 2);
    console.log("itemOrder (trackingId):", trackingId);
    const status = await wms.itemStatus(trackingId);
    console.log("itemStatus:", status);
    await wms.updateItemStatus(trackingId, "picked");
    console.log("updateItemStatus: picked");
    await wms.itemReceived(trackingId, "http://example.com/signature.png");
    console.log("itemReceived: done");
  } catch (err) {
    console.error("WMSAdapter error:", err);
  }
})();
