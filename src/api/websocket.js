const WebSocket  = require('ws');
const loginAngel = require('./angelAuth');

// Re-authenticates and reconnects — never reuses a potentially-expired JWT
async function reconnectWebSocket(onTick, delayMs = 5000) {
    console.log(`🔄 WebSocket reconnecting in ${delayMs / 1000}s (fresh auth)...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const freshAuth = await loginAngel();
    if (freshAuth) {
        startWebSocket(freshAuth, onTick);
    } else {
        // Auth failed — back off and retry (cap at 60s)
        console.error('❌ Re-auth failed — retrying in 60s');
        reconnectWebSocket(onTick, 60000);
    }
}

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

        let heartbeat   = null;
        let tickCount   = 0;

        ws.on('open', () => {
            console.log('✅ WebSocket Connected!');

            ws.send(JSON.stringify({
                correlationID: 'vardaannifty',
                action       : 1,
                params       : {
                    mode     : 1,        // ← mode 1 = LTP only (simplest)
                    tokenList: [{
                        exchangeType: 1,
                        tokens      : ['26000'] // NIFTY 50
                    }]
                }
            }));

            console.log('📊 Subscribed NIFTY 50 — mode 1 LTP');

            heartbeat = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.ping();
            }, 30000);
        });

        ws.on('message', (rawData) => {
            try {
                const buf = Buffer.isBuffer(rawData)
                    ? rawData
                    : Buffer.from(rawData);

                // First message: log hex for debugging
                if (tickCount === 0) {
                    console.log('First WS message hex:', buf.toString('hex').substring(0, 80));
                    console.log('First WS message length:', buf.length);
                }
                tickCount++;

                // Try JSON first (acknowledgment messages)
                const str = buf.toString('utf8');
                if (str.startsWith('{')) {
                    const json = JSON.parse(str);
                    console.log('WS JSON msg:', json);
                    return;
                }

                // Binary LTP parsing (mode 1)
                // Angel One LTP binary format:
                // Byte 0    : subscription type (1 byte)
                // Byte 1    : exchange type (1 byte)
                // Bytes 2-26: token string (25 bytes)
                // Bytes 27-34: sequence number (int64)
                // Bytes 35-42: exchange timestamp (int64)
                // Bytes 43-50: LTP in paise (int64 big-endian)

                if (buf.length >= 51) {
                    const ltpPaise = buf.readBigInt64BE(43);
                    const price    = Number(ltpPaise) / 100;

                    // Sanity check: NIFTY should be between 10000 and 50000
                    if (price > 10000 && price < 50000) {
                        if (tickCount <= 5 || tickCount % 50 === 0) {
                            console.log(`NIFTY WS tick: ${price}`);
                        }
                        if (typeof onTick === 'function') {
                            onTick({ price, source: 'websocket' });
                        }
                        return;
                    }
                }

                // If offset 43 didn't work, try other offsets
                const offsets = [35, 39, 43, 47, 51];
                for (const off of offsets) {
                    if (buf.length >= off + 8) {
                        try {
                            const ltpPaise = buf.readBigInt64BE(off);
                            const price    = Number(ltpPaise) / 100;
                            if (price > 10000 && price < 50000) {
                                console.log(`NIFTY WS (offset ${off}): ${price}`);
                                if (typeof onTick === 'function') {
                                    onTick({ price, source: 'websocket' });
                                }
                                return;
                            }
                        } catch(e) {}
                    }
                }

            } catch (e) {
                // ignore
            }
        });

        ws.on('error', (err) => {
            console.error('WebSocket Error:', err.message);
        });

        ws.on('close', (code) => {
            console.log('🔴 WebSocket Closed:', code);
            clearInterval(heartbeat);
            reconnectWebSocket(onTick, 5000);  // fresh auth every reconnect
        });

        ws.on('ping', () => ws.pong());

    } catch (err) {
        console.error('SOCKET START ERROR:', err.message);
        reconnectWebSocket(onTick, 10000);     // fresh auth here too
    }
}

module.exports = startWebSocket;
