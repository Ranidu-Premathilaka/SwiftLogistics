-- Stores notifications for users who are offline at delivery time.
-- Commands are never stored (time-sensitive); only 'event' and 'message' types.
CREATE TABLE IF NOT EXISTS pending_notifications (
    id         SERIAL PRIMARY KEY,
    user_id    VARCHAR(255) NOT NULL,
    type       VARCHAR(20)  NOT NULL CHECK (type IN ('event', 'message')),
    payload    JSONB        NOT NULL,
    delivered  BOOLEAN      NOT NULL DEFAULT false,
    created_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Fast lookup of undelivered notifications by user
CREATE INDEX IF NOT EXISTS idx_pending_notifications_user_undelivered
    ON pending_notifications (user_id)
    WHERE delivered = false;
