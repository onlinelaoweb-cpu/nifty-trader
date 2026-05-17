const WebSocket = require('ws');

let latestPrice = 0;

function startWebSocket(jwtToken) {

    const ws = new WebSocket(
        'wss://smartapisocket.angelone.in/smart-stream'
    );

    ws.on('open', () => {

        console.log('WebSocket Connected');

        ws.send(JSON.stringify({

            correlationID: 'vardaannifty',

            action: 1,

            params: {

                mode: 1,

                tokenList: [
                    {
                        exchangeType: 1,
                        tokens: ['26000']
                    }
                ]

            }

        }));

    });

    ws.on('message', (data) => {

        try {

            const tick = JSON.parse(data);

            console.log('LIVE TICK:', tick);

            latestPrice =
                tick.last_traded_price || 0;

        }

        catch(err){

            console.log(
                'Raw Tick:',
                data.toString()
            );

        }

    });

    ws.on('error', (err) => {

        console.error(
            'WebSocket Error:',
            err
        );

    });

    ws.on('close', () => {

        console.log('WebSocket Closed');

    });

}

module.exports = startWebSocket;
