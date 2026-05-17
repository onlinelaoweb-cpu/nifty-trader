const WebSocket = require('ws');

function startWebSocket(authData) {
    try {
        console.log('Starting WebSocket...');

        if (!authData?.feedToken) {
            console.error('❌ feedToken missing');
            return;
        }

        // ✅ Direct Angel One WebSocket — no SDK
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

        // ── Heartbeat every 30s ──────────────────
        let heartbeat = null;

        ws.on('open', () => {
            console.log('✅ WebSocket Connected!');

            // Subscribe to NIFTY 50
            const subscribeMsg = {
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
            };

            ws.send(JSON.stringify(subscribeMsg));
            console.log('📊 Subscribed to NIFTY 50');

            // Keep alive
            heartbeat = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, 30000);
        });

        ws.on('message', (rawData) => {
            try {
                // Angel sends binary data
                const data = JSON.parse(rawData.toString());
                if (data?.last_traded_price) {
                    const price = data.last_traded_price / 100;
                    console.log('NIFTY LIVE :', price);
                }
            } catch (e) {
                // Binary tick data — normal, ignore parse errors
            }
        });

        ws.on('error', (err) => {
            console.error('WebSocket Error:', err.message);
        });

        ws.on('close', (code, reason) => {
            console.log('🔴 WebSocket Closed:', code, reason.toString());
            clearInterval(heartbeat);
            console.log('⏳ Reconnecting in 5s...');
            setTimeout(() => startWebSocket(authData), 5000);
        });

        ws.on('ping', () => ws.pong());

    } catch (err) {
        console.error('SOCKET START ERROR:', err.message);
        setTimeout(() => startWebSocket(authData), 10000);
    }
}

module.exports = startWebSocket;
