const { SmartWebSocketV2 } =
require('smartapi-javascript');

function startWebSocket(authData) {

    try {

        const TOKEN =
            authData.jwtToken;

        const API_KEY =
            process.env.ANGEL_API_KEY;

        const CLIENT_CODE =
            process.env.ANGEL_CLIENT_ID;

        const FEED_TOKEN =
            authData.feedToken;

        const smart_ws =
            new SmartWebSocketV2(
                TOKEN,
                API_KEY,
                CLIENT_CODE,
                FEED_TOKEN
            );

        smart_ws.connect();

        smart_ws.on('connect', () => {

            console.log(
                'WebSocket Connected'
            );

            smart_ws.subscribe(
                'vardaannifty',
                1,
                [
                    {
                        exchangeType: 1,
                        tokens: ['26000']
                    }
                ]
            );

        });

        smart_ws.on('tick', (data) => {

            console.log(
                'LIVE TICK:',
                data
            );

        });

        smart_ws.on('error', (err) => {

            console.error(
                'WebSocket Error:',
                err
            );

        });

        smart_ws.on('close', () => {

            console.log(
                'WebSocket Closed'
            );

        });

    }

    catch(err){

        console.error(
            'SOCKET START ERROR:',
            err
        );

    }

}

module.exports = startWebSocket;
