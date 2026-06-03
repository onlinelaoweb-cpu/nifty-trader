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
        console.error('❌ Re-auth failed — retrying in 60s');
        reconnectWebSocket(onTick, 60000);
    }
}

// ── Angel One SmartAPI LTP binary packet (mode=1) ────────────────────────────
// Real tick format (47 bytes):
//   Byte   0    : subscription mode (1 = LTP)
//   Byte   1    : exchange type     (1 = NSE)
//   Bytes  2-26 : token string, null-padded to 25 bytes
//   Bytes 27-34 : sequence number (int64 LE)  ← NOT price
//   Bytes 35-42 : exchange timestamp (int64 LE)
//   Bytes 43-46 : LTP in paise (uint32 LE)    ← REAL PRICE
//
// Subscription ACK packet (40 bytes) also arrives first — it does NOT contain
// a valid LTP at offset 43 (packet too short), so we skip it.
//
// Returns price in rupees, or null if not parseable.
function parseLtpPacket(buf) {
    // Must be at least 47 bytes to have LTP at offset 43
    if (buf.length >= 47) {
        const ltpPaise = buf.readUInt32LE(43);
        const price    = ltpPaise / 100;
        // Nifty 50 realistic range: 15000 – 30000
        if (price >= 15000 && price <= 30000) {
            return price;
        }
        // Log bad value so we can diagnose further
        if (ltpPaise > 0) {
            console.warn(`[WS] offset-43 price out of Nifty range: ${price} (${ltpPaise} paise), buf[43:47]=${buf.slice(43,47).toString('hex')}`);
        }
    }

    // Subscription ACK (40 bytes) or malformed — skip silently
    return null;
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

        let heartbeat = null;
        let tickCount = 0;

        ws.on('open', () => {
            console.log('✅ WebSocket Connected!');

            ws.send(JSON.stringify({
                correlationID: 'vardaannifty',
                action       : 1,
                params       : {
                    mode     : 1,        // LTP only
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

                tickCount++;

                // Log hex for first 5 messages and any suspiciously short/long ones
                if (tickCount <= 5) {
                    console.log(`WS msg #${tickCount}: len=${buf.length} hex=${buf.toString('hex')}`);
                }

                // Try JSON first (acknowledgment messages)
                const str = buf.toString('utf8');
                if (str.startsWith('{') || str.startsWith('[')) {
                    try {
                        const json = JSON.parse(str);
                        console.log('WS JSON msg:', JSON.stringify(json));
                    } catch(e) {}
                    return;
                }

                // Parse binary LTP packet
                const price = parseLtpPacket(buf);
                if (price !== null) {
                    if (tickCount <= 10 || tickCount % 100 === 0) {
                        console.log(`NIFTY WS tick #${tickCount}: ${price}`);
                    }
                    if (typeof onTick === 'function') {
                        onTick({ price, source: 'websocket' });
                    }
                }

            } catch (e) {
                if (tickCount <= 10) console.error('WS parse error:', e.message);
            }
        });

        ws.on('error', (err) => {
            console.error('WebSocket Error:', err.message);
        });

        ws.on('close', (code) => {
            console.log('🔴 WebSocket Closed:', code);
            clearInterval(heartbeat);
            reconnectWebSocket(onTick, 5000);
        });

        ws.on('ping', () => ws.pong());

    } catch (err) {
        console.error('SOCKET START ERROR:', err.message);
        reconnectWebSocket(onTick, 10000);
    }
}

module.exports = startWebSocket;