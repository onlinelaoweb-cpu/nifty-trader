const SmartAPI = require('smartapi-javascript').SmartAPI;
const { TOTP, Secret } = require('otpauth');

async function loginAngel() {
    try {
        console.log('Trying SmartAPI SDK Login...');

        // ✅ Credentials check
        console.log('API_KEY present   :', !!process.env.ANGEL_API_KEY);
        console.log('CLIENT_ID present :', !!process.env.ANGEL_CLIENT_ID);
        console.log('PASSWORD present  :', !!process.env.ANGEL_PASSWORD);
        console.log('TOTP_SECRET length:', process.env.ANGEL_TOTP_SECRET?.length);

        const smartApi = new SmartAPI({
            api_key: process.env.ANGEL_API_KEY
        });

        // ✅ 25-char Angel One secret handle
        const totpCode = new TOTP({
            secret   : Secret.fromBase32(
                           process.env.ANGEL_TOTP_SECRET
                               .toUpperCase()
                               .replace(/\s/g, '')
                       ),
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

        // ✅ Full response for debugging
        console.log('FULL RESPONSE:', JSON.stringify(data, null, 2));
        console.log('STATUS     :', data?.status);
        console.log('MESSAGE    :', data?.message);
        console.log('ERROR CODE :', data?.errorCode);

        if (!data?.data?.jwtToken) {
            throw new Error(
                'Login response invalid: '
                + JSON.stringify(data)
            );
        }

        console.log('Login Success ✅');
        console.log('feedToken    :', data.data.feedToken ? '✅ present' : '❌ MISSING');

        return data.data;

    } catch (err) {
        console.error('SMARTAPI LOGIN ERROR:', err.message || err);
        return null;
    }
}

module.exports = loginAngel;
