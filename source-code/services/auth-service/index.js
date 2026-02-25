const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const InternalRouter = require('../utility/internalRouter');
const db             = require('../utility/db');
const config         = require('./config');

const PORT             = config.port;
const JWT_SECRET       = config.jwt.secret;
const ACCESS_TOKEN_EXPIRY  = config.jwt.accessTokenExpiry;
const REFRESH_TOKEN_EXPIRY = config.jwt.refreshTokenExpiry;

// ── DB bootstrap ──────────────────────────────────────────────────────────────

db.init();

// ── Handlers ──────────────────────────────────────────────────────────────────

async function signup({ username, password, role = 'client' }) {
    console.log(`[Auth] signup attempt: username=${username}, role=${role}`);

    if (!['client', 'driver'].includes(role)) {
        InternalRouter.sendRoutingError('Invalid role — must be client or driver', 400);
    }

    const existing = await db.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
        console.warn(`[Auth] signup failed: username=${username} already exists`);
        InternalRouter.sendRoutingError('User already exists', 409);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
        'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
        [username, passwordHash, role]
    );
    console.log(`[Auth] signup success: username=${username}, role=${role}`);
    return { message: 'User created successfully' };
}

async function login({ username, password }) {
    console.log(`[Auth] login attempt: username=${username}`);
    const result = await db.query('SELECT password_hash, role FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
        console.warn(`[Auth] login failed: username=${username} not found`);
        InternalRouter.sendRoutingError('Invalid credentials', 401);
    }

    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) {
        console.warn(`[Auth] login failed: wrong password for username=${username}`);
        InternalRouter.sendRoutingError('Invalid credentials', 401);
    }

    const { role } = result.rows[0];
    const accessToken  = jwt.sign({ username, role }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
    const refreshToken = jwt.sign({ username, role }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY });
    await db.query('INSERT INTO refresh_tokens (token, username) VALUES ($1, $2)', [refreshToken, username]);
    console.log(`[Auth] login success: username=${username}, role=${role}`);
    return { accessToken, refreshToken };
}

async function refreshAccessToken({ refreshToken }) {
    console.log('[Auth] refresh attempt');
    const result = await db.query('SELECT username FROM refresh_tokens WHERE token = $1', [refreshToken]);
    if (result.rows.length === 0) {
        console.warn('[Auth] refresh failed: token not found or already revoked');
        InternalRouter.sendRoutingError('Invalid or revoked refresh token', 401);
    }

    try {
        const payload     = jwt.verify(refreshToken, JWT_SECRET);
        const accessToken = jwt.sign({ username: payload.username, role: payload.role }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
        console.log(`[Auth] refresh success: username=${payload.username}, role=${payload.role}`);
        return { accessToken };
    } catch {
        await db.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
        console.warn('[Auth] refresh failed: token expired or invalid, revoked from DB');
        InternalRouter.sendRoutingError('Refresh token expired or invalid', 401);
    }
}

async function logout({ refreshToken }) {
    console.log('[Auth] logout attempt');
    await db.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    console.log('[Auth] logout success: refresh token revoked');
    return { message: 'Logged out successfully' };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async () => {
    const router = new InternalRouter();

    router.registerRoute('POST', '/signup',  signup);
    router.registerRoute('POST', '/login',   login);
    router.registerRoute('POST', '/refresh', refreshAccessToken);
    router.registerRoute('POST', '/logout',  logout);

    router.host(PORT);
    console.log(`[Auth] Service listening on port ${PORT}`);
})();
