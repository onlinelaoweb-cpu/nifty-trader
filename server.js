require('dotenv').config();

const express  = require('express');
const http     = require('http');
const cors     = require('cors');

const loginAngel                    = require('./src/api/angelAuth');
const startWebSocket                = require('./src/api/websocket');
const { processIndicators,
        initializeHistory,
        getCandleHistory }          = require('./src/api/indicators');
const { fetchMarketData }           = require('./src/api/marketData');
const { analyzeMultiTimeframe }     = require('./src/api/multiTimeframe');
const { fetchGlobalCues }           = require('./src/api/globalCues');
const {
    sendSignalAlert, sendMTFAlert,
    sendMorningSummary, sendVIXAlert,
    sendCloseSummary, isConfigured
}                                   = require('./src/api/telegram');

const app    = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

// ── Market State ──────────────────────────────────────
let marketState = {
    nifty: 0, change: 0, changePct: 0,
    signal: 'WAIT', confidence: 0,
    rsi: null, ema9: null, ema21: null, vwap: null,
    pcr: null, atmPcr: null, pcrSignal: 'N/A', atmPcrSignal: 'N/A',
    vix: null, vixChange: null, vixSignal: 'N/A', vixNote: '', strikeRange: 'ATM ±200',
    mtf: {
        signal: 'WAIT', strength: 'WEAK', confidence: 0,
        aligned: false, bullCount: 0, bearCount: 0,
        tf5m:  { rsi:null, ema9:null, ema21:null, vwap:null, signal:'NEUTRAL', score:50 },
        tf15m: { rsi:null, ema9:null, ema21:null, vwap:null, signal:'NEUTRAL', score:50 },
        tf1h:  { rsi:null, ema9:null, ema21:null, vwap:null, signal:'NEUTRAL', score:50 }
    },
    global: {
        bias: 'NEUTRAL', score: 50, reasons: ['Loading global data...'],
        updatedAt: null,
        us:          { dow:null, nasdaq:null, sp500:null },
        asia:        { nikkei:null, hangseng:null, shanghai:null },
        europe:      { dax:null, ftse:null },
        currency:    { usdinr:null, dxy:null },
        commodities: { crude:null, brent:null, gold:null, silver:null },
        sectors:     { bankNifty:null, niftyIT:null, niftyAuto:null, niftyMetal:null }
    },
    reason: ['Waiting for market data...'],
    lastUpdated: null, connected: false, source: 'none', dataPoints: 0
};

let historyLoaded = false, prevSignal = 'WAIT', prevMTFAligned = false;
let morningSummarySent = false, closeSummarySent = false, vixAlertSent = false;

function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
    const m   = ist.getHours()*60 + ist.getMinutes();
    return m >= 555 && m <= 930;
}
function getIST() { return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'})); }
function pcrLabel(v) { if(!v) return 'N/A'; if(v>1.5) return 'BULLISH'; if(v<0.7) return 'BEARISH'; return 'NEUTRAL'; }

function combineSignals(indicators) {
    let bull = 0, bear = 0;
    const reasons = [...(indicators.reasons || [])];

    if (marketState.pcr !== null) {
        if      (marketState.pcrSignal === 'BULLISH') { bull += 2; reasons.push(`PCR ${marketState.pcr} — Bullish ✅`); }
        else if (marketState.pcrSignal === 'BEARISH') { bear += 2; reasons.push(`PCR ${marketState.pcr} — Bearish ⚠️`); }
        else                                          { reasons.push(`PCR ${marketState.pcr} — Neutral`); }
    }
    if (marketState.vix) {
        if      (marketState.vixChange < -0.5) { bull++; reasons.push(`VIX falling (${marketState.vix}) ✅`); }
        else if (marketState.vixChange >  0.5) { bear++; reasons.push(`VIX rising (${marketState.vix}) ⚠️`); }
        if (marketState.vix > 25) reasons.push(`⚠️ VIX HIGH — ${marketState.vixNote}`);
    }

    // ✅ Global cues impact on signal
    if (marketState.global.bias === 'BULLISH') {
        bull += 2; reasons.push('Global cues bullish ✅');
    } else if (marketState.global.bias === 'BEARISH') {
        bear += 2; reasons.push('Global cues bearish ⚠️');
    }

    // Bank Nifty direct
    const bn = marketState.global.sectors?.bankNifty;
    if (bn?.changePct > 0.5) { bull += 2; }
    else if (bn?.changePct < -0.5) { bear += 2; }

    // USD/INR
    const fx = marketState.global.currency?.usdinr;
    if (fx?.changePct > 0.5) { bear++; reasons.push(`Rupee weak ₹${fx.price} ⚠️`); }

    // Crude
    const cr = marketState.global.commodities?.crude;
    if (cr?.changePct > 1.5) { bear++; reasons.push(`Crude rising ${cr.changePct}% ⚠️`); }

    if (marketState.mtf.aligned) {
        if      (marketState.mtf.signal === 'BUY CALL') { bull += 3; reasons.push('All 3 timeframes BULLISH 🔥'); }
        else if (marketState.mtf.signal === 'BUY PUT')  { bear += 3; reasons.push('All 3 timeframes BEARISH 🔥'); }
    } else if (marketState.mtf.bullCount === 2) { bull++; reasons.push('2/3 timeframes bullish'); }
    else if   (marketState.mtf.bearCount === 2) { bear++; reasons.push('2/3 timeframes bearish'); }

    bull += indicators.signal === 'BUY CALL' ? 3 : 0;
    bear += indicators.signal === 'BUY PUT'  ? 3 : 0;

    const total = bull + bear;
    let signal = 'WAIT', confidence = 0;
    if (total > 0) {
        const pct = (bull / total) * 100;
        if      (pct >= 65) { signal = 'BUY CALL'; confidence = Math.round(pct); }
        else if (pct <= 35) { signal = 'BUY PUT';  confidence = Math.round(100-pct); }
        else                { signal = 'WAIT';     confidence = 30; reasons.push('Mixed signals'); }
    }
    if (marketState.vix > 30) { signal = 'WAIT'; confidence = 0; reasons.push('VIX>30 — Avoid!'); }

    // Remove confusing "Mixed signals" from 1-min when higher timeframes override to a trade
    if (signal !== 'WAIT') {
        const idx = reasons.findIndex(r => r.includes('Mixed signals'));
        if (idx !== -1) reasons.splice(idx, 1);
    }

    return { signal, confidence, reasons };
}

async function checkTelegramAlerts(newSignal) {
    if (!isConfigured() || !isMarketOpen()) return;
    const ist = getIST(), h = ist.getHours(), m = ist.getMinutes();
    if (h===9 && m>=16 && m<=20 && !morningSummarySent) { morningSummarySent=true; await sendMorningSummary(marketState); return; }
    if (h===15 && m>=30 && !closeSummarySent) { closeSummarySent=true; await sendCloseSummary(marketState); setTimeout(()=>{morningSummarySent=false;closeSummarySent=false;vixAlertSent=false;},6*60*60*1000); return; }
    if (newSignal !== prevSignal && newSignal !== 'WAIT') await sendSignalAlert(marketState, prevSignal);
    if (marketState.mtf.aligned && !prevMTFAligned) await sendMTFAlert(marketState);
    prevMTFAligned = marketState.mtf.aligned;
    if (marketState.vix > 20 && !vixAlertSent) { vixAlertSent=true; await sendVIXAlert(marketState.vix, marketState.vixNote); }
    if (marketState.vix <= 20) vixAlertSent = false;
}

async function updatePrice(price, change, changePct, source) {
    const indicators = processIndicators(price);
    const { signal, confidence, reasons } = combineSignals(indicators);
    marketState.nifty=price; marketState.change=change; marketState.changePct=changePct;
    marketState.signal=signal; marketState.confidence=confidence;
    marketState.rsi=indicators.rsi; marketState.ema9=indicators.ema9; marketState.ema21=indicators.ema21; marketState.vwap=indicators.vwap;
    marketState.reason=reasons; marketState.lastUpdated=new Date().toISOString();
    marketState.connected=true; marketState.source=source; marketState.dataPoints=indicators.priceCount;
    if (source==='yahoo') console.log(`NIFTY:${price} RSI:${indicators.rsi||'--'} VWAP:${indicators.vwap||'--'} → ${signal}(${confidence}%)`);
    await checkTelegramAlerts(signal);
    prevSignal = signal;
}

function onTick(tickData) {
    const price = tickData.price;
    if (!price || price <= 0) return;
    const prev=marketState.nifty||price, change=parseFloat((price-prev).toFixed(2));
    const chgPct=prev>0?parseFloat(((change/prev)*100).toFixed(2)):0;
    updatePrice(price, change, chgPct, 'websocket');
}

async function refreshMarketData() {
    const { niftyData, vixData } = await fetchMarketData();
    if (niftyData?.closes?.length > 0 && !historyLoaded) { initializeHistory(niftyData.closes, niftyData.candles); historyLoaded=true; console.log(`History: ${niftyData.closes.length} candles`); }
    if (vixData)    { marketState.vix=vixData.vix; marketState.vixChange=vixData.change; marketState.vixSignal=vixData.signal; marketState.vixNote=vixData.note; marketState.strikeRange=vixData.strikeRange; }
    if (niftyData?.price > 0) {
        if (marketState.source !== 'websocket') await updatePrice(niftyData.price, niftyData.change, niftyData.changePct, 'yahoo');
        else { marketState.change=niftyData.change; marketState.changePct=niftyData.changePct; }
    }
}

async function refreshMTF() {
    try { const d=await analyzeMultiTimeframe(); if(d) { marketState.mtf={signal:d.mtfSignal,strength:d.mtfStrength,confidence:d.mtfConfidence,aligned:d.aligned,bullCount:d.bullCount,bearCount:d.bearCount,tf5m:d.tf5m,tf15m:d.tf15m,tf1h:d.tf1h}; console.log(`MTF: ${d.mtfSignal} (${d.mtfStrength})`); } } catch(e) { console.error('MTF error:',e.message); }
}

async function refreshGlobal() {
    try {
        const globalData = await fetchGlobalCues();
        if (globalData) marketState.global = globalData;
    } catch(e) { console.error('Global cues error:', e.message); }
}

// ── Routes ────────────────────────────────────────────
app.get('/api/signal',  (req,res) => res.json(marketState));
app.get('/api/candles', (req,res) => res.json(getCandleHistory()));
app.get('/api/global',  (req,res) => res.json(marketState.global));

// ── Chart proxy — avoids browser CORS restrictions ──
app.get('/api/chart', async (req, res) => {
    const tf = req.query.tf || '5m';
    const intervalMap = { '5m': '5m', '15m': '15m', '1h': '60m' };
    const rangeMap    = { '5m': '5d',  '15m': '5d',  '1h': '1mo' };
    const interval = intervalMap[tf] || '5m';
    const range    = rangeMap[tf]    || '5d';
    try {
        const axios = require('axios');
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=${interval}&range=${range}&includePrePost=false`;
        const r = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            timeout: 10000
        });
        const q = r.data?.chart?.result?.[0]?.indicators?.quote?.[0];
        const candles = [];
        if (q) {
            const { open, high, low, close, volume } = q;
            for (let i = 0; i < close.length; i++) {
                if (close[i] != null && high[i] != null && low[i] != null) {
                    candles.push({ open: open[i]||close[i], high: high[i], low: low[i], close: close[i], volume: volume[i]||1 });
                }
            }
        }
        res.json(candles);
    } catch(e) {
        console.error('Chart proxy error:', e.message);
        res.json([]);
    }
});

app.get('/api/health', (req,res) => res.json({
    status: marketState.connected?'live':'waiting',
    nifty: marketState.nifty, vix: marketState.vix,
    globalBias: marketState.global.bias,
    bankNifty: marketState.global.sectors?.bankNifty?.price,
    usdinr: marketState.global.currency?.usdinr?.price,
    telegram: isConfigured()?'configured':'not configured',
    source: marketState.source, lastUpdated: marketState.lastUpdated
}));

app.post('/api/pcr', (req,res) => {
    const {pcr,atmPcr}=req.body;
    if(pcr!=null)    { marketState.pcr=parseFloat(pcr);    marketState.pcrSignal=pcrLabel(marketState.pcr);    console.log(`PCR: ${marketState.pcr}`); }
    if(atmPcr!=null) { marketState.atmPcr=parseFloat(atmPcr); marketState.atmPcrSignal=pcrLabel(marketState.atmPcr); }
    res.json({success:true});
});

app.post('/api/telegram/test', async (req,res) => {
    if (!isConfigured()) return res.json({success:false,msg:'Not configured'});
    await sendMorningSummary(marketState);
    res.json({success:true,msg:'Test message sent!'});
});

app.get('/', (req,res) => res.sendFile(__dirname+'/public/index.html'));

async function initializeLiveData() {
    console.log('Starting VardaanNifty AI...');
    console.log('Telegram:', isConfigured()?'✅':'❌');

    // ✅ FIX: Load global & MTF FIRST so combineSignals has full context on first price update
    await Promise.all([refreshGlobal(), refreshMTF()]);
    await refreshMarketData();

    setInterval(refreshMarketData, 3*60*1000);
    setInterval(refreshMTF,        5*60*1000);
    setInterval(refreshGlobal,     5*60*1000);

    const auth = await loginAngel();
    if (auth) { console.log('Angel Login Success'); startWebSocket(auth, onTick); }
    else      { console.log('Yahoo Finance fallback'); setTimeout(initializeLiveData, 30000); }
}

initializeLiveData();
server.listen(PORT, ()=>console.log(`VardaanNifty AI running on port ${PORT}`));

