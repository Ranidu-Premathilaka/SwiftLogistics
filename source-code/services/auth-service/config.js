module.exports = {
    port: process.env.PORT || 3000,

    jwt: {
        secret:              process.env.JWT_SECRET || 'dev-secret-change-in-production',
        accessTokenExpiry:   '15m',
        refreshTokenExpiry:  '7d',
    },
};
