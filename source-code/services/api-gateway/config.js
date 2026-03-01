module.exports = {
    // Maps the first URL path segment to an internal Docker service URL.
    // Docker DNS resolves these hostnames automatically within the internal network.
    // Add a new entry here when a new service is added.
    serviceMap: {
        'auth':      'http://auth-service:3000',
        'notify':    'http://notify-service:3000',
        'order':     'http://order-service:3000',
        'items':     'http://items-service:3000',
        'deliveries': 'http://delivery-service:3000',
    },

    // Routes that bypass JWT validation (prefix match).
    publicPrefixes: ['/auth/', '/health'],

    port: process.env.PORT || 8080,
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
};
