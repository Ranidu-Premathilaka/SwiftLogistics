const { Pool } = require('pg');

class Database {
    constructor() {
        this.pool = null;
    }

    /**
     * Initialize the database connection pool using environment variables
     */
    init() {
        if (this.pool) {
            console.warn('[DB] Pool already initialized.');
            return;
        }

        console.log('[DB] Initializing connection pool...');
        this.pool = new Pool({
            user: process.env.DB_USER || 'postgres',
            host: process.env.DB_HOST || 'localhost',
            database: process.env.DB_NAME || 'logistic_db',
            password: process.env.DB_PASSWORD || 'postgres',
            port: process.env.DB_PORT || 5432,
        });

        this.pool.on('error', (err, client) => {
            console.error('[DB] Unexpected error on idle client', err);
            // Don't exit process here in a class method, maybe emit error or log it
        });
        
        console.log('[DB] Pool initialized.');
    }

    /**
     * Execute a query against the database
     * @param {string} text - The SQL query string
     * @param {Array} params - The values for the parameterized query
     * @returns {Promise<import('pg').QueryResult>}
     */
    async query(text, params) {
        if (!this.pool) {
            throw new Error('[DB] Pool not initialized. Call init() first.');
        }
        
        // console.log(`[DB] Executing query: ${text}`);
        return this.pool.query(text, params);
    }

    /**
     * Get a client from the pool for transactions
     * @returns {Promise<import('pg').PoolClient>}
     */
    async getClient() {
        if (!this.pool) {
            throw new Error('[DB] Pool not initialized. Call init() first.');
        }
        return this.pool.connect();
    }

    /**
     * Gracefully close the pool
     */
    async close() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            console.log('[DB] Pool closed.');
        }
    }
}

// Export a singleton instance so it can be shared
module.exports = new Database();
