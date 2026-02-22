const express = require('express');

class routingError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.name = "RoutingError";
        this.statusCode = statusCode;
    }
}

// Ment to be used for services to register their methods with the api gateway with restAPI
// This only supports a single method 
class internalRouter {
    static routingError = routingError;

    constructor() {
        this.routes = {};
        this.app = null;
        this.allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
        this.notNeedIdempotencyKey = ["GET"];
        this.processedRequestIds = new Set(); // Move this to a more persistent storage like redis
        this.#initRoutes();
    }  

    #initRoutes(){
        this.allowedMethods.forEach(method => {
            this.routes[method] = {};
        });
    }

    #hasIdempotentKey(requestId){
        return this.processedRequestIds.has(requestId);
    }

    #idempotentHandler(method, requestId) {

        if(this.notNeedIdempotencyKey.includes(method)) {
            return;
        }

        if (!requestId) {
            throw new routingError("Missing x-request-id header", 400);
        }

        // Check if the request ID has already been processed
        if (this.#hasIdempotentKey(requestId)) {
            console.log(`Duplicate request received with ID: ${requestId}`);
            throw new routingError("Duplicate request - already processed", 409);
        }

        // Mark the request ID as processed
        this.processedRequestIds.add(requestId);
    }

    #route(method, path, data, headers) {

        if(this.routes[method] && this.routes[method][path]) {
            const routeInfo = this.routes[method][path];
            return routeInfo.handler({ ...data, headers });
            
        }else{
            throw new routingError(`Route not found: ${method} ${path}`, 404);
        }
    }

    /**
     *  exits and returns the error to the client 
     * @param {string} errorMessage : Ex: "Route not found: GET /order/createOrder" 
     * @param {int} statusCode : Ex: 404
     */
    static sendRoutingError(errorMessage, statusCode) {
        throw new routingError(errorMessage, statusCode);
    }

    /**
     * 
     * @param {string} method : HTTP method (GET, POST, PUT, PATCH, DELETE)
     * @param {string} route : string of the mapped api route. ex : /order/createOrder
     * @param {function} handler : handler function for the route (async and sync functions supported).
     *                             Receives a single object with all body/query params plus a `headers` key.
     */
    registerRoute(method, route, handler) {
        if(!this.allowedMethods.includes(method)) {
            throw new routingError(`Method ${method} is not allowed. Allowed methods are: ${this.allowedMethods.join(", ")}`, 405);
        }

        this.routes[method][route] = {
            handler: handler
        };
    }

    host(port) {
        this.app = express();
        this.app.use(express.json());

        this.app.all("*", async (req, res) => {
            try {
                if(!this.allowedMethods.includes(req.method)) {
                    throw new routingError('Method not allowed', 405);
                }

                this.#idempotentHandler(req.method, req.headers['x-request-id']);

                const result = await this.#route(req.method, req.path, req.method === "GET" ? req.query : req.body, req.headers);
                res.status(200).send(result);
            } catch (e) {
                if(e instanceof routingError && e.statusCode) {
                    res.status(e.statusCode).send(e.message);
                } else {
                    console.error('[InternalRouter] Unhandled error:', e);
                    res.status(500).send("Internal Server Error");
                }
            }
        });

        this.app.listen(port);
    }
}

module.exports = internalRouter;