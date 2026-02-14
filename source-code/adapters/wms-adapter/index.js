/**
 * WMS Adapter - Warehouse Management System
 * @description Adapter for integrating with Warehouse Management System (WMS)
 *
 * @interface WMSAdapter
 *
 * @method itemInStock - Check if an item is in stock in WMS
 * @param {string} itemId - Item ID to check in stock
 * @returns {Promise<boolean>} Promise that resolves to true if item is in stock, false otherwise
 * 
 * @method itemOrder - Reserve an item in WMS for an order
 * @param {string} itemId - Item ID to reserve
 * @param {number} quantity - Quantity to reserve
 * @returns {string} Tracking ID for the reservation
 * 
 * @method itemStatus - Get the status of an item in WMS
 * @param {string} trackingId - Tracking ID for the reservation
 * @returns {Promise<string>} Promise that resolves to the status of the item (e.g., "reserved", "picked", "shipped")
 * 
 * @method updateItemStatus - Update the status of an item in WMS
 * @param {string} trackingId - Tracking ID for the reservation
 * @param {string} status - New status to update (e.g., "picked", "shipped")
 * @returns {Promise<void>} Promise that resolves when the status is updated
 * 
 * @method itemReceived - Mark an item as received in WMS
 * @param {string} trackingId - Tracking ID for the reservation
 * @param {string} signatureUrl - URL to the signature image for proof of delivery  
 * @returns {Promise<void>} Promise that resolves when the item is marked as received
 * 
 */

const axios = require("axios");
class WMSAdapter {
    constructor({ url, port }) {
        this.baseUrl = `http://${url}:${port}`;
    }

    async itemInStock(itemId) {
        const response = await axios.get(`${this.baseUrl}/stock/${itemId}`);
        return response.data.inStock;
    }

    async itemOrder(itemId, quantity) {
        const response = await axios.post(`${this.baseUrl}/order`, { itemId, quantity });
        return response.data.trackingId;
    }

    async itemStatus(trackingId) {
        const response = await axios.get(`${this.baseUrl}/status/${trackingId}`);
        return response.data.status;
    }

    async updateItemStatus(trackingId, status) {
        await axios.put(`${this.baseUrl}/status/${trackingId}`, { status });
    }

    async itemReceived(trackingId, signatureUrl) {
        await axios.post(`${this.baseUrl}/received`, { trackingId, signatureUrl });
    }
}

module.exports = WMSAdapter;