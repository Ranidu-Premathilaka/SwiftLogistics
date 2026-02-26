CREATE TABLE IF NOT EXISTS orders (
    id         SERIAL PRIMARY KEY,
    order_id   VARCHAR(255) UNIQUE NOT NULL,
    client_id  VARCHAR(255) NOT NULL,
    item_list  JSONB        NOT NULL DEFAULT '[]',
    status     VARCHAR(50)  NOT NULL DEFAULT 'pending_payment',
    created_at TIMESTAMP    NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders (order_id);
