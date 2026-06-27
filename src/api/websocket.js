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

// ── Angel One SmartAPI Mode 2 (Quote) binary packet — 195 bytes ─────────────
//
// Byte layout (all little-endian):
//   0      : subscription mode (2 = Quote)
//   1      : exchange type     (1 = NSE CM)
//   2–26   : token string, null-padded to 25 bytes
//   27–34  : sequence number   (int64 LE)
//   35–42  : exchange timestamp (int64 LE, epoch seconds)
//   43–46  : LTP               (uint32 LE, in PAISE)   ← price
//   47–50  : Last Traded Qty   (uint32 LE)
//   51–58  : Avg Trade Price   (int64 LE, in paise)
//   59–62  : Volume            (uint32 LE, session cumulative)  ← real volume
//   63–66  : Total Buy Qty     (uint32 LE)  ← buy-side pressure
//   67–70  : Total Sell Qty    (uint32 LE)  ← sell-side pressure → Delta!
//   71–78  : Open price        (int64 LE, in paise)
//   79–86  : High price        (int64 LE, in paise)
//   87–94  : Low price         (int64 LE, in paise)
//   95–102 : Close/Prev Close  (int64 LE, in paise)
//
// Subscription ACK packet (40 bytes) arrives first — skip it (too short).
// Mode 1 (LTP only, 47 bytes) may also arrive during reconnects — handle both.
//
// Returns { price, volume, buyQty, sellQty, open, high, low, close, exchTs }
// or null if packet is not parseable.
function parseQuotePacket(buf) {
    // Mode 2 full quote = 195 bytes minimum
    if (buf.length >= 195) {
        const mode = buf.readUInt8(0);
        if (mode !== 2) {
            // Unexpected mode in a 195-byte packet — log and skip
            console.warn(`[WS] Unexpected mode ${mode} in 195-byte packet`);
            return null;
        }

        const ltpPaise  = buf.readUInt32LE(43);
        const price     = ltpPaise / 100;

        // Sanity check: Nifty realistic range
        if (price < 15000 || price > 35000) {
            if (ltpPaise > 0) console.warn(`[WS] Mode2 price out of range: ${price}`);
            return null;
        }

        const volume    = buf.readUInt32LE(59);
        const buyQty    = buf.readUInt32LE(63);
        const sellQty   = buf.readUInt32LE(67);
        const open      = Number(buf.readBigInt64LE(71))  / 100;
        const high      = Number(buf.readBigInt64LE(79))  / 100;
        const low       = Number(buf.readBigInt64LE(87))  / 100;
        const close     = Number(buf.readBigInt64LE(95))  / 100;
        const exchTs    = Number(buf.readBigInt64LE(35)); // epoch seconds

        return { price, volume, buyQty, sellQty, open, high, low, close, exchTs };
    }

    // Mode 1 fallback (47 bytes) — only LTP available, volume=0
    if (buf.length >= 47) {
        const mode = buf.readUInt8(0);
        if (mode === 1) {
            const ltpPaise = buf.readUInt32LE(43);
            const price    = ltpPaise / 100;
            if (price >= 15000 && price <= 35000) {
                console.warn(`[WS] Mode1 fallback packet (${buf.length}b) — volume unavailable`);
                return { price, volume: 0, buyQty: 0, sellQty: 0, open: 0, high: 0, low: 0, close: 0, exchTs: 0 };
            }
        }
    }

    // ACK (40 bytes) or unknown — skip silently
    return null;
}

function startWebSocket(authData, onTick) {
    try {
        console.log('Starting WebSocket (Mode 2 — Quote + Volume)...');

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
                    mode     : 2,        // Quote — LTP + OHLCV + Buy/Sell Qty
                    tokenList: [{
                        exchangeType: 1,
                        tokens      : ['26000'] // NIFTY 50
                    }]
                }
            }));

            console.log('📊 Subscribed NIFTY 50 — mode 2 Quote (price + volume + buy/sell qty)');

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

                // Log first 5 packets for debugging
                if (tickCount <= 5) {
                    console.log(`WS msg #${tickCount}: len=${buf.length} hex=${buf.slice(0, 20).toString('hex')}...`);
                }

                // JSON = acknowledgment message
                const str = buf.toString('utf8');
                if (str.startsWith('{') || str.startsWith('[')) {
                    try {
                        const json = JSON.parse(str);
                        console.log('WS JSON msg:', JSON.stringify(json));
                    } catch(e) {}
                    return;
                }

                // Parse Mode 2 binary quote packet
                const tick = parseQuotePacket(buf);
                if (tick !== null) {
                    if (tickCount <= 10 || tickCount % 100 === 0) {
                        console.log(`NIFTY WS tick #${tickCount}: ₹${tick.price} | Vol:${tick.volume} | Buy:${tick.buyQty} Sell:${tick.sellQty} | O:${tick.open} H:${tick.high} L:${tick.low}`);
                    }
                    if (typeof onTick === 'function') {
                        onTick({
                            price   : tick.price,
                            volume  : tick.volume,
                            buyQty  : tick.buyQty,
                            sellQty : tick.sellQty,
                            open    : tick.open,
                            high    : tick.high,
                            low     : tick.low,
                            close   : tick.close,
                            exchTs  : tick.exchTs,
                            source  : 'websocket'
                        });
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