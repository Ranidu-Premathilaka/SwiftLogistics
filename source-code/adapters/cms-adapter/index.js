/**
 * CMS Adapter
 * @description Adapter for CMS (Client Management System) integration
 *
 * @interface CMSAdapter
 *
 * @method startConnection - Start connection to CMS
 *
 * @method clientAuthenticate - Authenticate client with CMS
 * @param {string} clientId - Client ID for authentication
 * @param {string} clientSecret - Client secret for authentication
 * @returns {Object} Authentication result object
 *
 * @method getClientOrderID - Get client order information from CMS
 * @param {string} clientId - Client ID to fetch order information
 * @returns {Array} List of client orders
 *
 * @method getOrderInfo - Get order information from CMS
 * @param {string} orderId - Order ID to fetch information
 * @returns {Object} Order information object
 *
 * @method createOrder - Create order in CMS
 * @param {Object} orderData - Order data to create in CMS
 * @param {Object} transactionInfo - Transaction information related to the order
 * @returns {boolean} Result of create operation
 *
 * @method updateOrder - Update order in CMS
 * @param {string} orderId - Order ID to update in CMS
 * @param {Object} updateData - Data to update the order with
 * @returns {Object} Updated order information object
 *
 * @method deleteOrder - Delete order in CMS
 * @param {string} orderId - Order ID to delete in CMS
 * @returns {boolean} Result of delete operation
 *
 */

const soap = require("soap");

class CMSAdapter {
  #baseUrl;
  #CMSClient;

  constructor({ url, port }) {
    this.#baseUrl = `${url}:${port}`;
    this.#CMSClient = null;
  }

  /** Initialize SOAP client (must be called before using adapter) */
  async init() {
    // Create SOAP client using WSDL
    this.#CMSClient = await soap.createClientAsync(this.#baseUrl + "/wsdl?wsdl");
  }

  /** Send SOAP request using node-soap client */
  async #sendSOAPRequest(action, args) {
    if (!this.#CMSClient) {
      throw new Error("CMSClient not initialized. Call init() first.");
    }

    try {
      // node-soap generates async methods automatically
      const methodName = action + "Async"; // e.g., "AuthenticateClient" -> "AuthenticateClientAsync"
      if (typeof this.#CMSClient[methodName] !== "function") {
        throw new Error(`SOAP method ${methodName} not found in WSDL`);
      }

      const [result] = await this.#CMSClient[methodName](args); // returns array with result
      return result;
    } catch (err) {
      throw new Error(`SOAP request failed: ${err.message}`);
    }
  }

  /** Public methods */

  async clientAuthenticate(clientId, clientSecret) {
    const args = { clientId, clientSecret };
    const response = await this.#sendSOAPRequest("AuthenticateClient", args);
    return response.AuthenticateClientResponse;
  }

  async getClientOrderID(clientId) {
    const args = { clientId };
    const response = await this.#sendSOAPRequest("GetClientOrders", args);
    return response.GetClientOrdersResponse.orders;
  }

  async getOrderInfo(orderId) {
    const args = { orderId };
    const response = await this.#sendSOAPRequest("GetOrderInfo", args);
    return response.GetOrderInfoResponse.order;
  }

  async createOrder(orderData, transactionInfo) {
    const args = { orderData, transactionInfo };
    const response = await this.#sendSOAPRequest("CreateOrder", args);
    return response.CreateOrderResponse.success;
  }

  async updateOrder(orderId, updateData) {
    const args = { orderId, updateData };
    const response = await this.#sendSOAPRequest("UpdateOrder", args);
    return response.UpdateOrderResponse.updatedOrder;
  }

  async deleteOrder(orderId) {
    const args = { orderId };
    const response = await this.#sendSOAPRequest("DeleteOrder", args);
    return response.DeleteOrderResponse.success;
  }
}

module.exports = CMSAdapter;
