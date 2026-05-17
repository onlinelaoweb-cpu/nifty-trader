const axios = require('axios');
const { TOTP, Secret } = require('otpauth');

async function loginAngel() {
    try {
        console.log('Trying Angel One Login...');
        console.log('CLIENT_ID:', process.env.ANGEL_CLIENT_ID);

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
        console.log('FULL RESPONSE:', JSON.stringify(data, null, 2));

        if (!data?.data?.jwtToken) {
            throw new Error(
                'Login failed: ' + JSON.stringify(data)
            );
        }

        console.log('✅ Login Success!');
        console.log('jwtToken  :', data.data.jwtToken  ? '✅' : '❌');
        console.log('feedToken :', data.data.feedToken ? '✅' : '❌');

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
