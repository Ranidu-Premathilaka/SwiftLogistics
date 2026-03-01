CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'driver')),
    created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    token      TEXT PRIMARY KEY,
    username   VARCHAR(255) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
);
