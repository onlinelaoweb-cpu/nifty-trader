const WebSocket = require('ws');

function startWebSocket(authData, onTick) {
    try {
        console.log('Starting WebSocket...');

        if (!authData?.feedToken) {
            console.error('❌ feedToken missing');
            return;
        }

        const ws = new WebSocket(
            'wss://smartapisocket.angelone.in/smart-stream',
            {
                headers: {
                    'Authorization' : authData.jwtToken,
                    'x-api-key'     : process.env.ANGEL_API_KEY,
                    'x-client-code' : process.env.ANGEL_CLIENT_ID,
                    'x-feed-token'  : authData.feedToken
                }
            }
        );

        let heartbeat = null;

        ws.on('open', () => {
            console.log('✅ WebSocket Connected!');

            ws.send(JSON.stringify({
                correlationID: 'vardaannifty',
                action       : 1,
                params       : {
                    mode     : 2,
                    tokenList: [
                        {
                            exchangeType: 1,
                            tokens      : ['26000'] // NIFTY 50
                        }
                    ]
                }
            }));

            console.log('📊 Subscribed to NIFTY 50');

            // Keep alive ping every 30s
            heartbeat = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, 30000);
        });

        ws.on('message', (rawData) => {
            try {
                const data = JSON.parse(rawData.toString());

                if (data?.last_traded_price) {
                    const price = data.last_traded_price / 100;

                    // ✅ server.js ko callback karo
                    if (typeof onTick === 'function') {
                        onTick({ price });
                    }
                }
            } catch (e) {
                // Binary data — ignore
            }
        });

        ws.on('error', (err) => {
            console.error('WebSocket Error:', err.message);
        });

        ws.on('close', (code) => {
            console.log('🔴 WebSocket Closed:', code);
            clearInterval(heartbeat);
            console.log('⏳ Reconnecting in 5s...');
            setTimeout(
                () => startWebSocket(authData, onTick),
                5000
            );
        });

        ws.on('ping', () => ws.pong());

    } catch (err) {
        console.error('SOCKET START ERROR:', err.message);
        setTimeout(
            () => startWebSocket(authData, onTick),
            10000
        );
    }
}

module.exports = startWebSocket;
