/**
 * 
 * Self host at some port
 * 
 * Accepts: SOAP Based XML requests
 * 
 * Process with DB
 * 
 */
const http = require("http");
const soap = require("soap");
const { port } = require("./config");

// 1️⃣ Define your service (fake implementation)
const cmsService = {
  CMSService: {
    CMSPort: {
      AuthenticateClient({ clientId, clientSecret }) {
        console.log("AuthenticateClient called:", clientId, clientSecret);
        return {
          AuthenticateClientResponse: {
            success: true,
            token: "mock-token-123",
          },
        };
      },

      GetClientOrders({ clientId }) {
        console.log("GetClientOrders called:", clientId);
        return {
          GetClientOrdersResponse: {
            orders: [
              { orderId: "order1", amount: 100 },
              { orderId: "order2", amount: 250 },
            ],
          },
        };
      },

      GetOrderInfo({ orderId }) {
        console.log("GetOrderInfo called:", orderId);
        return {
          GetOrderInfoResponse: {
            order: { orderId, items: [{ productId: "p1", qty: 2 }] },
          },
        };
      },

      CreateOrder({ orderData, transactionInfo }) {
        console.log("CreateOrder called:", orderData, transactionInfo);
        return {
          CreateOrderResponse: { success: true },
        };
      },

      UpdateOrder({ orderId, updateData }) {
        console.log("UpdateOrder called:", orderId, updateData);
        return {
          UpdateOrderResponse: {
            updatedOrder: { orderId, ...updateData },
          },
        };
      },

      DeleteOrder({ orderId }) {
        console.log("DeleteOrder called:", orderId);
        return {
          DeleteOrderResponse: { success: true },
        };
      },
    },
  },
};

// 2️⃣ WSDL definition (mock; includes all adapter operations)
// NOTE: This WSDL intentionally keeps payloads loosely-typed (xsd:anyType) for simplicity.
const wsdlXml = `
<definitions name="CMSService"
  targetNamespace="http://example.com/cms"
  xmlns:tns="http://example.com/cms"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/">

  <message name="AuthenticateClientRequest">
    <part name="clientId" type="xsd:string"/>
    <part name="clientSecret" type="xsd:string"/>
  </message>
  <message name="AuthenticateClientResponse">
    <part name="success" type="xsd:boolean"/>
    <part name="token" type="xsd:string"/>
  </message>

  <message name="GetClientOrdersRequest">
    <part name="clientId" type="xsd:string"/>
  </message>
  <message name="GetClientOrdersResponse">
    <part name="orders" type="xsd:anyType"/>
  </message>

  <message name="GetOrderInfoRequest">
    <part name="orderId" type="xsd:string"/>
  </message>
  <message name="GetOrderInfoResponse">
    <part name="order" type="xsd:anyType"/>
  </message>

  <message name="CreateOrderRequest">
    <part name="orderData" type="xsd:anyType"/>
    <part name="transactionInfo" type="xsd:anyType"/>
  </message>
  <message name="CreateOrderResponse">
    <part name="success" type="xsd:boolean"/>
  </message>

  <message name="UpdateOrderRequest">
    <part name="orderId" type="xsd:string"/>
    <part name="updateData" type="xsd:anyType"/>
  </message>
  <message name="UpdateOrderResponse">
    <part name="updatedOrder" type="xsd:anyType"/>
  </message>

  <message name="DeleteOrderRequest">
    <part name="orderId" type="xsd:string"/>
  </message>
  <message name="DeleteOrderResponse">
    <part name="success" type="xsd:boolean"/>
  </message>

  <portType name="CMSPortType">
    <operation name="AuthenticateClient">
      <input message="tns:AuthenticateClientRequest"/>
      <output message="tns:AuthenticateClientResponse"/>
    </operation>
    <operation name="GetClientOrders">
      <input message="tns:GetClientOrdersRequest"/>
      <output message="tns:GetClientOrdersResponse"/>
    </operation>
    <operation name="GetOrderInfo">
      <input message="tns:GetOrderInfoRequest"/>
      <output message="tns:GetOrderInfoResponse"/>
    </operation>
    <operation name="CreateOrder">
      <input message="tns:CreateOrderRequest"/>
      <output message="tns:CreateOrderResponse"/>
    </operation>
    <operation name="UpdateOrder">
      <input message="tns:UpdateOrderRequest"/>
      <output message="tns:UpdateOrderResponse"/>
    </operation>
    <operation name="DeleteOrder">
      <input message="tns:DeleteOrderRequest"/>
      <output message="tns:DeleteOrderResponse"/>
    </operation>
  </portType>

  <binding name="CMSBinding" type="tns:CMSPortType">
    <soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>

    <operation name="AuthenticateClient">
      <soap:operation soapAction="AuthenticateClient"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>

    <operation name="GetClientOrders">
      <soap:operation soapAction="GetClientOrders"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>

    <operation name="GetOrderInfo">
      <soap:operation soapAction="GetOrderInfo"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>

    <operation name="CreateOrder">
      <soap:operation soapAction="CreateOrder"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>

    <operation name="UpdateOrder">
      <soap:operation soapAction="UpdateOrder"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>

    <operation name="DeleteOrder">
      <soap:operation soapAction="DeleteOrder"/>
      <input><soap:body use="literal"/></input>
      <output><soap:body use="literal"/></output>
    </operation>
  </binding>

  <service name="CMSService">
    <port name="CMSPort" binding="tns:CMSBinding">
      <soap:address location="/wsdl"/>
    </port>
  </service>
</definitions>
`;

// 3️⃣ Start HTTP server and attach SOAP service
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

