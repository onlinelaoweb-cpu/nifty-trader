const SmartAPI = require('smartapi-javascript').SmartAPI;
const { TOTP } = require('otpauth');

async function loginAngel() {
    try {
        console.log('Trying SmartAPI SDK Login...');

        const smartApi = new SmartAPI({
            api_key: process.env.ANGEL_API_KEY
        });

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

        // ✅ Full response log karo debug ke liye
        console.log('FULL RESPONSE:', JSON.stringify(data, null, 2));
        console.log('STATUS:', data?.status);
        console.log('MESSAGE:', data?.message);
        console.log('ERROR CODE:', data?.errorCode);

        if (!data?.data?.jwtToken) {
            throw new Error(
                'Login response invalid: '
                + JSON.stringify(data)
            );
        }

        console.log('Login Success');
        console.log('feedToken:', data.data.feedToken ? '✅' : '❌ MISSING');

        return data.data;

    } catch (err) {
        console.error('SMARTAPI LOGIN ERROR:', err.message || err);
        return null;
    }
}

module.exports = loginAngel;
