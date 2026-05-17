const axios = require('axios');

async function loginAngel() {

    try {

        const response = await axios.post(
            'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
            {
                clientcode: process.env.ANGEL_CLIENT_ID,
                password: process.env.ANGEL_PASSWORD,
                totp: process.env.ANGEL_TOTP
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-PrivateKey': process.env.ANGEL_API_KEY
                }
            }
        );

        return response.data.data;

    } catch (err) {

        console.error(
            'Angel Login Error:',
            err.response?.data || err.message
        );

    }

}

module.exports = loginAngel;
