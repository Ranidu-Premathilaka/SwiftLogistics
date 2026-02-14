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

const xml2js = require("xml2js");
const axios = require("axios");

class CMSAdapter {
  #baseUrl;

  constructor({ url, port }) {
    this.#baseUrl = `${url}:${port}`;
  }

  /**Converts XML -> JS Object */
  async #parseXML(xml) {
    const parser = new xml2js.Parser({ explicitArray: false });
    return parser.parseStringPromise(xml);
  }

  async #sendSOAPRequest(action, bodyXML) {
    const envelope = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
        <soapenv:Header/>
        <soapenv:Body>
          ${bodyXML}
        </soapenv:Body>
      </soapenv:Envelope>
    `;

    try {
      const response = await axios.post(this.#baseUrl, envelope, {
        headers: {
          "Content-Type": "text/xml",
          SOAPAction: action,
        },
        timeout: 5000,
      });

      return await this.#parseXML(response.data);
    } catch (error) {
      throw new Error("CMS SOAP request failed");
    }
  }

  #extractBody(parsedXML) {
    return parsedXML["soapenv:Envelope"]["soapenv:Body"];
  }

  async clientAuthenticate(clientId, clientSecret) {
    const bodyXML = `
      <AuthenticateClientRequest>
        <clientId>${clientId}</clientId>
        <clientSecret>${clientSecret}</clientSecret>
      </AuthenticateClientRequest>
    `;
    const response = await this.#sendSOAPRequest("AuthenticateClient", bodyXML);
    const body = this.#extractBody(response);
    return body.AuthenticateClientResponse;
  }
  async getClientOrderID(clientId) {
    const bodyXML = `
      <GetClientOrdersRequest>
        <clientId>${clientId}</clientId>
      </GetClientOrdersRequest>
    `;
    const response = await this.#sendSOAPRequest("GetClientOrders", bodyXML);
    const body = this.#extractBody(response);
    return body.GetClientOrdersResponse.orders;
  }
  async getOrderInfo(orderId) {
    const bodyXML = `
      <GetOrderInfoRequest>
        <orderId>${orderId}</orderId>
      </GetOrderInfoRequest>
    `;
    const response = await this.#sendSOAPRequest("GetOrderInfo", bodyXML);
    const body = this.#extractBody(response);
    return body.GetOrderInfoResponse.order;
  }
  async createOrder(orderData, transactionInfo) {
    const bodyXML = `
      <CreateOrderRequest>
        <orderData>${JSON.stringify(orderData)}</orderData>
        <transactionInfo>${JSON.stringify(transactionInfo)}</transactionInfo>
      </CreateOrderRequest>
    `;
    const response = await this.#sendSOAPRequest("CreateOrder", bodyXML);
    const body = this.#extractBody(response);
    return body.CreateOrderResponse.success;
  }
  async updateOrder(orderId, updateData) {
    const bodyXML = `
      <UpdateOrderRequest>
        <orderId>${orderId}</orderId>
        <updateData>${JSON.stringify(updateData)}</updateData>
      </UpdateOrderRequest>
    `;
    const response = await this.#sendSOAPRequest("UpdateOrder", bodyXML);
    const body = this.#extractBody(response);
    return body.UpdateOrderResponse.updatedOrder;
  }
  async deleteOrder(orderId) {
    const bodyXML = `
      <DeleteOrderRequest>
        <orderId>${orderId}</orderId>
      </DeleteOrderRequest>
    `;
    const response = await this.#sendSOAPRequest("DeleteOrder", bodyXML);
    const body = this.#extractBody(response);
    return body.DeleteOrderResponse.success;
  }
}

// function startConnection(){
//     config = loadConfig();
//     cmsDeployedUrl = config.cmsUrl;
//     cmsDeployedPort = config.cmsPort;

//     // Connection to the CMS system using the deployed URL and port

// }

// function createOrder(orderData, transactionInfo, callback){
//     SOAP slfkjsflkj;
//     slfkjas->slfaskdfj
//     lskfj

//     CMSModule.createOrder(orderData, transactionInfo, function(err, result){
//         if(err){
//             return callback(err);
//         }
//         callback(null, result);
//     });

// }

// function createOrder(orderData, transactionInfo, callback){

//     // Validation
//     // DB logic

//     //callback
// }
