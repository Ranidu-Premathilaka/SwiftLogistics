const internalRouter = require('../utility/internalRouter');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const config = require('./config');

const JWT_SECRET = process.env.JWT_SECRET || config.JWT_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || config.REFRESH_TOKEN_SECRET;

if (!JWT_SECRET) throw new Error('JWT_SECRET is not defined');
if (!REFRESH_TOKEN_SECRET) throw new Error('REFRESH_TOKEN_SECRET is not defined');

const router = new internalRouter();

router.registerRoute('POST', '/login', {email: 'string', password: 'string'},login);
router.registerRoute('POST', '/refresh', {refreshToken: 'string'},refresh);
router.registerRoute('POST', '/login/verify', {accessToken: 'string'},verifyAccessToken);



/***
 * @param {string} email
 * @param {string} password
 * @returns {object}  JWT token & Refresh Token if login is successful, error message if login fails
 */
async function login(email, password) {

    if (!validateEmail(email)) {
        return router.sendRoutingError("Invalid email format", 400);
    }

    if (!validatePassword(password)) {
        return router.sendRoutingError("Password must be at least 6 characters long", 400);
    }

    const user = confirmUser(email);
    if (!user) {
        return router.sendRoutingError("Invalid email or password", 401);
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
        return router.sendRoutingError("Invalid email or password", 401);
    }

    const accessToken = generateAccessToken(user.id, user.role);
    const refreshToken = generateRefreshToken(user.id, user.role);

    storeRefreshToken(user.id, refreshToken);

    return {
        accessToken,
        refreshToken,
        userId: user.id,
        role: user.role
    };
}



function verifyAccessToken(accessToken) {
    try {
        return jwt.verify(accessToken, JWT_SECRET);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return router.sendRoutingError("Access token has expired", 401);
        }
        return router.sendRoutingError("Invalid access token", 401);
    }
}

function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function validatePassword(password) {
    return password.length >= 6;
}



function generateAccessToken(userId, role) {
    return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '15m' });
}

function generateRefreshToken(userId, role) {
    return jwt.sign({ userId, role }, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });
}

function refresh(refreshToken) {
    if(!refreshToken){
        return router.sendRoutingError("Refresh token is required", 400);
    }
    let payload;
    try {
        payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return router.sendRoutingError("Refresh token has expired", 401);
        }
        return router.sendRoutingError("Invalid refresh token", 401);
    }

    const storedToken = getStoredRefreshToken(payload.userId);
    if (storedToken !== refreshToken) {
        return router.sendRoutingError("Refresh token does not match stored token", 401);
    }



    const newAccessToken = generateAccessToken(payload.userId, payload.role);

    return { 
        accessToken: newAccessToken, 
    };
}







/******
 * 
 * NEED TO IMPLEMENT THE DATABASE LOGIC FOR THESE LATER
 * 
 */
function storeRefreshToken(userId, refreshToken) {
    console.log(`Storing refresh token for user ${userId}: ${refreshToken}`);
    return true; // Simulate successful storage
}

function getStoredRefreshToken(userId) {
    console.log(`Retrieving stored refresh token for user ${userId}`);
    return null; // Simulate no stored token
}

function confirmUser(email) {
    // Simulate user lookup - In a real application, this would query the database
    const dummyUser = {
        id: 'user-123',
        email: 'test@mail.com',
        passwordHash: bcrypt.hashSync('password123', 10), // Simulated hashed password
        role: 'customer'
    };
    return email === dummyUser.email ? dummyUser : null;
}










router.host(3000);
