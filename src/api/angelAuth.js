const axios = require('axios');
const { TOTP, Secret } = require('otpauth');

async function loginAngel() {
    try {
        console.log('Trying Angel One Login...');
        // CLIENT_ID logged for debug — safe (not a secret)
        console.log('CLIENT_ID:', process.env.ANGEL_CLIENT_ID);
        // SECURITY: never log TOTP codes or tokens
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

        console.log('TOTP: generated ✅ (6-digit, not logged)');

        // ✅ Direct REST API — no SDK
        const response = await axios.post(
            'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
            {
                clientcode : process.env.ANGEL_CLIENT_ID,
                password   : process.env.ANGEL_PASSWORD,
                totp       : totpCode
            },
            {
                headers: {
                    'Content-Type'      : 'application/json',
                    'Accept'            : 'application/json',
                    'X-UserType'        : 'USER',
                    'X-SourceID'        : 'WEB',
                    'X-ClientLocalIP'   : '127.0.0.1',
                    'X-ClientPublicIP'  : '127.0.0.1',
                    'X-MACAddress'      : '00:00:00:00:00:00',
                    'X-PrivateKey'      : process.env.ANGEL_API_KEY
                }
            }
        );

        const data = response.data;
        // SECURITY: never log full response — contains live JWT tokens
        // console.log('FULL RESPONSE:', JSON.stringify(data, null, 2)); // REMOVED

        if (!data?.data?.jwtToken) {
            throw new Error(
                'Login failed: ' + (data?.message || data?.errorcode || 'No jwtToken in response')
            );
        }

        console.log('✅ Login Success!');
        console.log('jwtToken  :', data.data.jwtToken  ? '✅ present' : '❌ missing');
        console.log('feedToken :', data.data.feedToken ? '✅ present' : '❌ missing');
        // SECURITY: return only the token values — never log them

        return data.data;

    } catch (err) {
        if (err.response) {
            // Angel API ne error diya
            console.error('API ERROR STATUS:', err.response.status);
            console.error('API ERROR DATA  :', JSON.stringify(err.response.data));
        } else {
            console.error('LOGIN ERROR:', err.message);
        }
        return null;
    }
}

module.exports = loginAngel;