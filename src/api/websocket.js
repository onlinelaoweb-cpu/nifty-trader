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

// ── Angel One SmartStream v2 Mode 2 (Quote) binary packet — 123 bytes ────────
//
// v1 was 195 bytes. v2 is 123 bytes.
// Difference: v2 removed `last_traded_qty` (4 bytes) and `avg_trade_price`
// (8 bytes) that sat between LTP and Volume in v1 — total 12 bytes removed.
// Everything after byte 46 shifts UP by 12. LTP and header are unchanged.
//
// Byte layout (all little-endian):
//   0      : subscription mode (2 = Quote)
//   1      : exchange type     (1 = NSE CM)
//   2–26   : token string, null-padded to 25 bytes
//   27–34  : sequence number   (int64 LE)
//   35–42  : exchange timestamp (int64 LE, epoch seconds)
//   43–46  : LTP               (uint32 LE, in PAISE)
//   47–50  : Volume            (uint32 LE, session cumulative)  ← was 59 in v1
//   51–54  : Total Buy Qty     (uint32 LE)                      ← was 63 in v1
//   55–58  : Total Sell Qty    (uint32 LE)                      ← was 67 in v1
//   59–66  : Open price        (int64 LE, in paise)             ← was 71 in v1
//   67–74  : High price        (int64 LE, in paise)             ← was 79 in v1
//   75–82  : Low price         (int64 LE, in paise)             ← was 87 in v1
//   83–90  : Close/Prev Close  (int64 LE, in paise)             ← was 95 in v1
//   91–122 : OI + circuit limits (32 bytes)
//
// Returns { price, volume, buyQty, sellQty, open, high, low, close, exchTs }
// or null if packet is not parseable.
function parseQuotePacket(buf) {
    // Mode 2 full quote — v2 = 123 bytes, v1 = 195 bytes
    if (buf.length >= 123) {
        const mode = buf.readUInt8(0);
        if (mode !== 2) {
            console.warn(`[WS] Unexpected mode ${mode} in ${buf.length}-byte packet`);
            return null;
        }

        const ltpPaise = buf.readUInt32LE(43);
        const price    = ltpPaise / 100;

        if (price < 15000 || price > 35000) {
            if (ltpPaise > 0) console.warn(`[WS] Price out of range: ${price}`);
            return null;
        }

        // v2 offsets (v1 offsets - 12 for all fields after byte 46)
        const volume  = buf.readUInt32LE(47);
        const buyQty  = buf.readUInt32LE(51);
        const sellQty = buf.readUInt32LE(55);
        const open    = Number(buf.readBigInt64LE(59)) / 100;
        const high    = Number(buf.readBigInt64LE(67)) / 100;
        const low     = Number(buf.readBigInt64LE(75)) / 100;
        const close   = Number(buf.readBigInt64LE(83)) / 100;
        const exchTs  = Number(buf.readBigInt64LE(35)); // unchanged

        return { price, volume, buyQty, sellQty, open, high, low, close, exchTs };
    }

    // Mode 1 LTP-only fallback (47 bytes)
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
                    mode     : 2,
                    tokenList: [{
                        exchangeType: 1,
                        tokens      : ['26000']
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

                if (tickCount <= 5) {
                    console.log(`WS msg #${tickCount}: len=${buf.length} hex=${buf.slice(0, 20).toString('hex')}...`);
                }

                const str = buf.toString('utf8');
                if (str.startsWith('{') || str.startsWith('[')) {
                    try { console.log('WS JSON msg:', JSON.stringify(JSON.parse(str))); } catch(e) {}
                    return;
                }

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

        ws.on('error',  (err)  => { console.error('WebSocket Error:', err.message); });
        ws.on('close',  (code) => {
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