const SmartAPI = require('smartapi-javascript').SmartAPI;
const { TOTP }  = require('otpauth');

async function loginAngel() {
    try {
        console.log('Trying SmartAPI SDK Login...');

        const smartApi = new SmartAPI({
            api_key: process.env.ANGEL_API_KEY
        });

        // ✅ Dynamic TOTP — har 30s mein fresh
        const totpCode = new TOTP({
            secret   : process.env.ANGEL_TOTP_SECRET,
            digits   : 6,
            period   : 30,
            algorithm: 'SHA1'
        }).generate();

        console.log('TOTP Generated:', totpCode);

        const data = await smartApi.generateSession(
            process.env.ANGEL_CLIENT_ID,
            process.env.ANGEL_PASSWORD,
            totpCode
        );

        // ✅ Check karo response valid hai
        if (!data?.data?.jwtToken) {
            throw new Error(
                'Login response invalid: '
                + JSON.stringify(data)
            );
        }

        console.log('Login Success');
        console.log('feedToken:', data.data.feedToken ? '✅' : '❌ MISSING');

        return data.data; // { jwtToken, feedToken, refreshToken }

    } catch (err) {
        console.error('SMARTAPI LOGIN ERROR:', err.message || err);
        return null;
    }
}

module.exports = loginAngel;
