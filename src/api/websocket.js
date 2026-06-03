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

// ── Parse Angel One SmartAPI binary tick (mode 1 LTP) ────────────────────────
// Angel One sends LTP packets in one of two sizes:
//   • 40-byte compact:  mode(1)+exchange(1)+token(25)+ltp_paise_LE32(4)+vol(4)+ts_LE32(4)+extra(1)
//   • 51-byte extended: same header + seq_BE64(8) + ts_BE64(8) + ltp_BE64(8)
// Returns price in rupees, or null if not parseable.
function parseLtpPacket(buf) {
    // Try 40-byte compact format first (most common for mode 1)
    if (buf.length >= 31) {
        // offset 27: LTP in paise, uint32 little-endian
        const ltpPaise = buf.readUInt32LE(27);
        const price    = ltpPaise / 100;
        if (price > 10000 && price < 50000) return price;
    }

    // Try 51-byte extended format (big-endian int64)
    if (buf.length >= 51) {
        const ltpPaise = buf.readBigInt64BE(43);
        const price    = Number(ltpPaise) / 100;
        if (price > 10000 && price < 50000) return price;
    }

    // Fallback: brute-force scan all 4-byte LE windows for NIFTY-range value
    for (let off = 27; off <= buf.length - 4; off++) {
        const val   = buf.readUInt32LE(off);
        const price = val / 100;
        if (price > 18000 && price < 32000) return price; // tighter NIFTY range
    }

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

        let heartbeat   = null;
        let tickCount   = 0;

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

                // Try JSON first (acknowledgment messages)
                const str = buf.toString('utf8');
                if (str.startsWith('{') || str.startsWith('[')) {
                    const json = JSON.parse(str);
                    console.log('WS JSON msg:', JSON.stringify(json));
                    return;
                }

                // Log every packet header for first 10 ticks to help debug format
                if (tickCount <= 10) {
                    console.log(`WS tick #${tickCount}: len=${buf.length} hex=${buf.toString('hex').substring(0, 60)}`);
                }

                // Parse binary LTP packet
                const price = parseLtpPacket(buf);
                if (price !== null) {
                    if (tickCount <= 10 || tickCount % 50 === 0) {
                        console.log(`NIFTY WS tick #${tickCount}: ${price}`);
                    }
                    if (typeof onTick === 'function') {
                        onTick({ price, source: 'websocket' });
                    }
                } else {
                    // Only log parse failures for first 10 ticks
                    if (tickCount <= 10) {
                        console.warn(`WS tick #${tickCount}: could not parse price from ${buf.length}-byte packet`);
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
            reconnectWebSocket(onTick, 5000);  // fresh auth every reconnect
        });

        ws.on('ping', () => ws.pong());

    } catch (err) {
        console.error('SOCKET START ERROR:', err.message);
        reconnectWebSocket(onTick, 10000);     // fresh auth here too
    }
}

module.exports = startWebSocket;