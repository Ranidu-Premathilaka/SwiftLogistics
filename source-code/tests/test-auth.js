/**
 * Auth tests — signup, login, token refresh, logout
 *
 * Usage:
 *   node source-code/tests/test-auth.js
 *
 * Requires the full stack to be running (./start.sh)
 */

const { request, test, assert, summary } = require('./helpers');

// Use a unique username per run to avoid conflicts with stale DB data
const USERNAME = `testuser_${Date.now()}`;
const PASSWORD = 'TestPassword123';

let accessToken  = null;
let refreshToken = null;

(async () => {
    console.log('\n── Auth Service Tests ───────────────────────────────');

    // ── Signup ────────────────────────────────────────────────────────────────

    await test('POST /auth/signup → 200 creates a new user', async () => {
        const { status, body } = await request('POST', '/auth/signup', {
            username: USERNAME,
            password: PASSWORD,
        }, { 'x-request-id': `signup-${Date.now()}` });

        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(body.message === 'User created successfully', `Unexpected message: ${body.message}`);
    });

    await test('POST /auth/signup → 409 on duplicate username', async () => {
        const { status, body } = await request('POST', '/auth/signup', {
            username: USERNAME,
            password: PASSWORD,
        }, { 'x-request-id': `signup-dup-${Date.now()}` });

        assert(status === 409, `Expected 409, got ${status}: ${JSON.stringify(body)}`);
    });

    // ── Login ─────────────────────────────────────────────────────────────────

    await test('POST /auth/login → 200 returns accessToken and refreshToken', async () => {
        const { status, body } = await request('POST', '/auth/login', {
            username: USERNAME,
            password: PASSWORD,
        }, { 'x-request-id': `login-${Date.now()}` });

        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken  === 'string', 'Missing accessToken');
        assert(typeof body.refreshToken === 'string', 'Missing refreshToken');

        accessToken  = body.accessToken;
        refreshToken = body.refreshToken;
    });

    await test('POST /auth/login → 401 on wrong password', async () => {
        const { status } = await request('POST', '/auth/login', {
            username: USERNAME,
            password: 'wrongpassword',
        }, { 'x-request-id': `login-bad-${Date.now()}` });

        assert(status === 401, `Expected 401, got ${status}`);
    });

    await test('POST /auth/login → 401 on unknown user', async () => {
        const { status } = await request('POST', '/auth/login', {
            username: 'nobody',
            password: 'irrelevant',
        }, { 'x-request-id': `login-nouser-${Date.now()}` });

        assert(status === 401, `Expected 401, got ${status}`);
    });

    // ── Token refresh ─────────────────────────────────────────────────────────

    await test('POST /auth/refresh → 200 returns new accessToken', async () => {
        const { status, body } = await request('POST', '/auth/refresh', {
            refreshToken,
        }, { 'x-request-id': `refresh-${Date.now()}` });

        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
        assert(typeof body.accessToken === 'string', 'Missing accessToken in refresh response');
    });

    await test('POST /auth/refresh → 401 on invalid token', async () => {
        const { status } = await request('POST', '/auth/refresh', {
            refreshToken: 'not-a-valid-token',
        }, { 'x-request-id': `refresh-bad-${Date.now()}` });

        assert(status === 401, `Expected 401, got ${status}`);
    });

    // ── Gateway JWT guard ─────────────────────────────────────────────────────

    await test('Protected route → 401 with no token', async () => {
        const { status } = await request('GET', '/order/anything');
        assert(status === 401, `Expected 401, got ${status}`);
    });

    await test('Protected route → 401 with invalid token', async () => {
        const { status } = await request('GET', '/order/anything', null, {
            Authorization: 'Bearer this.is.not.valid',
        });
        assert(status === 401, `Expected 401, got ${status}`);
    });

    await test('Protected route → not 401 with valid token', async () => {
        const { status } = await request('GET', '/order/anything', null, {
            Authorization: `Bearer ${accessToken}`,
        });
        // order-service isn't running so we expect 502, but NOT 401
        assert(status !== 401, `Token was rejected — got 401`);
    });

    // ── Logout ────────────────────────────────────────────────────────────────

    await test('POST /auth/logout → 200 revokes refresh token', async () => {
        const { status, body } = await request('POST', '/auth/logout', {
            refreshToken,
        }, { 'x-request-id': `logout-${Date.now()}` });

        assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    await test('POST /auth/refresh → 401 after logout', async () => {
        const { status } = await request('POST', '/auth/refresh', {
            refreshToken,
        }, { 'x-request-id': `refresh-after-logout-${Date.now()}` });

        assert(status === 401, `Expected 401 after logout, got ${status}`);
    });

    summary();
})();
