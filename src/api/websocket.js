const WebSocket = require('ws');

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

        console.log(
            'Live Tick:',
            data.toString()
        );

    });

    ws.on('error', (err) => {

        console.error(err);

    });

}

module.exports = startWebSocket;
