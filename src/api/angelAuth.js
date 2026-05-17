const SmartApi = require('smartapi-javascript');

async function loginAngel() {

    try {

        console.log('Trying SmartAPI SDK Login...');

        const smartApi = new SmartApi({
            api_key: process.env.ANGEL_API_KEY
        });

        const data = await smartApi.generateSession(
            process.env.ANGEL_CLIENT_ID,
            process.env.ANGEL_PASSWORD,
            process.env.ANGEL_TOTP
        );

        console.log('Login Success');

        return data.data;

    }

    catch (err) {

        console.error(
            'SMARTAPI LOGIN ERROR:',
            err.message || err
        );

    }

}

module.exports = loginAngel;
