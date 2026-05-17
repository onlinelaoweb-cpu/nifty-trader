// ✅ Bug 2 Fix — Node.js ko WebSocket chahiye
global.WebSocket = require('ws');

const { SmartWebSocketV2 } =
    require('smartapi-javascript');

function startWebSocket(authData) {
    try {
        console.log('Starting WebSocket...');

        // ✅ feedToken check
        if (!authData?.feedToken) {
            console.error('❌ feedToken missing — cannot connect');
            return;
        }

        const smart_ws = new SmartWebSocketV2(
            authData.jwtToken,
            process.env.ANGEL_API_KEY,
            process.env.ANGEL_CLIENT_ID,
            authData.feedToken
        );

        smart_ws.connect();

        // ✅ Bug 3 Fix — 'connect' → 'open'
        smart_ws.on('open', () => {
            console.log('✅ WebSocket Connected!');

            smart_ws.subscribe(
                'vardaannifty',
                3,              // mode 3 = full quote
                [
                    {
                        exchangeType: 1,
                        tokens: ['26000'] // NIFTY 50
                    }
                ]
            );

            console.log('📊 Subscribed to NIFTY 50');
        });

        smart_ws.on('tick', (data) => {
            const price = data?.last_traded_price;
            if (price) {
                // Angel sends price in paise → divide by 100
                console.log('NIFTY LIVE:', price / 100);
            }
        });

        smart_ws.on('error', (err) => {
            console.error('WebSocket Error:', err);
        });

        smart_ws.on('close', () => {
            console.log('🔴 WebSocket Closed — reconnecting in 5s...');
            setTimeout(() => startWebSocket(authData), 5000);
        });

    } catch (err) {
        console.error('SOCKET START ERROR:', err);
        setTimeout(() => startWebSocket(authData), 10000);
    }
}

module.exports = startWebSocket;
