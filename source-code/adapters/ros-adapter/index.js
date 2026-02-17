/**
 * ROS Adapter - Route Optimization System
 * @description This module doesn't need a adapter but is implemented for future proofing
 * 
 * @interface ROSAdapter
 * 
 * @method getOptimalRoute - Get the optimized route for a given set of waypoints
 * @param {string} origin - The starting point of the route
 * @param {Array} waypoints - An array of waypoints to optimize the route for
 * @returns {Promise} - A promise that resolves to the optimized route
 *
 */

const axios = require("axios");
class ROSAdapter {
    constructor({ url, port } = {}) {
        const baseUrl = url && port ? `http://${url}:${port}` : "http://localhost:9000";
        this.baseUrl = `${baseUrl}/api/ros`; // Base URL for the ROS API
    }
    getOptimalRoute(origin, waypoints) {
        return axios.post(`${this.baseUrl}/optimize-route`, {
            origin,
            waypoints,
        })
        .then(response => response.data)
        .catch(error => {
            console.error("Error fetching optimal route:", error);
            throw error;
        });
    }
}

module.exports = ROSAdapter;
