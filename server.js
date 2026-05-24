require('dotenv').config();

const express  = require('express');
const http     = require('http');
const cors     = require('cors');
const axios    = require('axios');

const loginAngel                    = require('./src/api/angelAuth');
const startWebSocket                = require('./src/api/websocket');
const { processIndicators,
        initializeHistory,
        getCandleHistory }          = require('./src/api/indicators');
const { fetchMarketData }           = require('./src/api/marketData');
const { analyzeMultiTimeframe }     = require('./src/api/multiTimeframe');
const { fetchGlobalCues }           = require('./src/api/globalCues');
const { fetchAdvanceDecline }       = require('./src/api/breadth');
const { calculateSRLevels }         = require('./src/api/levels');
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
        tf5m:  { rsi:null,ema9:null,ema21:null,vwap:null,signal:'NEUTRAL',score:50 },
        tf15m: { rsi:null,ema9:null,ema21:null,vwap:null,signal:'NEUTRAL',score:50 },
        tf1h:  { rsi:null,ema9:null,ema21:null,vwap:null,signal:'NEUTRAL',score:50 }
    },
    global: {
        bias:'NEUTRAL', score:50, reasons:['Loading...'],
        updatedAt:null, us:{}, asia:{}, europe:{}, currency:{}, commodities:{}, sectors:{}
    },
    breadth: {
        advances:0, declines:0, unchanged:0, total:0,
        adRatio:0, breadthPct:50, weightedBull:50,
        breadthSignal:'NEUTRAL', bullWeight:0, bearWeight:0,
        stocks:[], updatedAt:null
    },
    srLevels: null,
    pcrHistory: [],
    fii: { buy:null, sell:null, net:null },
    dii: { buy:null, sell:null, net:null },
    optionFlow: { atmCEpremium:null, atmPEpremium:null, ceChange:0, peChange:0, dominance:'NEUTRAL', history:[] },
    reason: ['Waiting...'], lastUpdated:null, connected:false, source:'none', dataPoints:0
};

// ── Trade Journal ─────────────────────────────────────
let trades       = [];
let tradeCounter = 1;
let events       = [];

// ── Helpers ───────────────────────────────────────────
let historyLoaded=false, prevSignal='WAIT', prevMTFAligned=false;
let morningSummarySent=false, closeSummarySent=false, vixAlertSent=false;

function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
    const m   = ist.getHours()*60 + ist.getMinutes();
    return m >= 555 && m <= 930;
}
function getIST() { return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'})); }
function pcrLabel(v) { if(!v) return 'N/A'; if(v>1.5) return 'BULLISH'; if(v<0.7) return 'BEARISH'; return 'NEUTRAL'; }

function trackPCRHistory(pcr) {
    if (!pcr) return;
    const ist  = getIST();
    const time = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    marketState.pcrHistory.push({ time, pcr: parseFloat(pcr.toFixed(2)), signal: pcrLabel(pcr) });
    if (marketState.pcrHistory.length > 50) marketState.pcrHistory.shift();
}

function updateOptionFlow(atmCE, atmPE) {
    const prev = marketState.optionFlow;
    const ceChange = atmCE && prev.atmCEpremium ? parseFloat((((atmCE-prev.atmCEpremium)/prev.atmCEpremium)*100).toFixed(2)) : 0;
    const peChange = atmPE && prev.atmPEpremium ? parseFloat((((atmPE-prev.atmPEpremium)/prev.atmPEpremium)*100).toFixed(2)) : 0;
    let dominance = 'NEUTRAL';
    if      (ceChange > 1 && ceChange > peChange+1)  dominance = 'CALL BUYERS';
    else if (peChange > 1 && peChange > ceChange+1)  dominance = 'PUT BUYERS';
    else if (ceChange < -1 && ceChange < peChange-1) dominance = 'CALL SELLERS';
    else if (peChange < -1 && peChange < ceChange-1) dominance = 'PUT SELLERS';
    const ist = getIST();
    const time = `${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    const history = [...(prev.history||[])];
    if (dominance !== 'NEUTRAL') { history.push({time,dominance,ceChange,peChange}); if(history.length>20) history.shift(); }
    marketState.optionFlow = { atmCEpremium:atmCE||prev.atmCEpremium, atmPEpremium:atmPE||prev.atmPEpremium, ceChange, peChange, dominance, history };
}

// ── Signal Generator ──────────────────────────────────
function combineSignals(indicators) {
    let bull=0, bear=0;
    const reasons=[...(indicators.reasons||[])];

    if (marketState.pcr!==null) {
        if      (marketState.pcrSignal==='BULLISH') { bull+=2; reasons.push(`PCR ${marketState.pcr} — Bullish ✅`); }
        else if (marketState.pcrSignal==='BEARISH') { bear+=2; reasons.push(`PCR ${marketState.pcr} — Bearish ⚠️`); }
        else reasons.push(`PCR ${marketState.pcr} — Neutral`);
    }
    if (marketState.vix) {
        if      (marketState.vixChange < -0.5) { bull++; reasons.push(`VIX falling (${marketState.vix}) ✅`); }
        else if (marketState.vixChange >  0.5) { bear++; reasons.push(`VIX rising (${marketState.vix}) ⚠️`); }
        if (marketState.vix > 25) reasons.push(`⚠️ VIX HIGH — ${marketState.vixNote}`);
    }
    if (marketState.global.bias==='BULLISH') { bull+=2; reasons.push('Global cues bullish ✅'); }
    else if (marketState.global.bias==='BEARISH') { bear+=2; reasons.push('Global cues bearish ⚠️'); }
    const bn = marketState.global.sectors?.bankNifty;
    if (bn?.changePct > 0.5) bull+=2; else if (bn?.changePct < -0.5) bear+=2;
    const br = marketState.breadth;
    if      (br.breadthSignal==='BULLISH') { bull+=2; reasons.push(`A/D ${br.advances}↑/${br.declines}↓ Bullish ✅`); }
    else if (br.breadthSignal==='BEARISH') { bear+=2; reasons.push(`A/D ${br.advances}↑/${br.declines}↓ Bearish ⚠️`); }
    else if (br.advances>0||br.declines>0) reasons.push(`A/D ${br.advances}↑/${br.declines}↓ Mixed`);
    const fx=marketState.global.currency?.usdinr;
    if (fx?.changePct > 0.5) { bear++; reasons.push(`Rupee weak ₹${fx.price} ⚠️`); }
    const cr=marketState.global.commodities?.crude;
    if (cr?.changePct > 1.5) { bear++; reasons.push(`Crude rising ${cr.changePct}% ⚠️`); }
    if (marketState.fii.net!==null) {
        if      (marketState.fii.net > 0) { bull++; reasons.push(`FII Buy ₹${marketState.fii.net}Cr ✅`); }
        else if (marketState.fii.net < 0) { bear++; reasons.push(`FII Sell ₹${marketState.fii.net}Cr ⚠️`); }
    }
    if (marketState.mtf.aligned) {
        if      (marketState.mtf.signal==='BUY CALL') { bull+=3; reasons.push('All 3 timeframes BULLISH 🔥'); }
        else if (marketState.mtf.signal==='BUY PUT')  { bear+=3; reasons.push('All 3 timeframes BEARISH 🔥'); }
    } else if (marketState.mtf.bullCount===2) { bull++; reasons.push('2/3 TF bullish'); }
    else if   (marketState.mtf.bearCount===2) { bear++; reasons.push('2/3 TF bearish'); }
    bull += indicators.signal==='BUY CALL' ? 3 : 0;
    bear += indicators.signal==='BUY PUT'  ? 3 : 0;
    const total=bull+bear;
    let signal='WAIT', confidence=0;
    if (total>0) {
        const pct=(bull/total)*100;
        if      (pct>=65) { signal='BUY CALL'; confidence=Math.round(pct); }
        else if (pct<=35) { signal='BUY PUT';  confidence=Math.round(100-pct); }
        else              { signal='WAIT';     confidence=30; reasons.push('Mixed signals'); }
    }
    if (marketState.vix>30) { signal='WAIT'; confidence=0; reasons.push('VIX>30 — Avoid!'); }
    return { signal, confidence, reasons };
}

async function checkTelegramAlerts(newSignal) {
    if (!isConfigured()||!isMarketOpen()) return;
    const ist=getIST(), h=ist.getHours(), m=ist.getMinutes();
    if (h===9&&m>=16&&m<=20&&!morningSummarySent) { morningSummarySent=true; await sendMorningSummary(marketState); return; }
    if (h===15&&m>=30&&!closeSummarySent) { closeSummarySent=true; await sendCloseSummary(marketState); setTimeout(()=>{morningSummarySent=false;closeSummarySent=false;vixAlertSent=false;},6*60*60*1000); return; }
    if (newSignal!==prevSignal&&newSignal!=='WAIT') await sendSignalAlert(marketState,prevSignal);
    if (marketState.mtf.aligned&&!prevMTFAligned) await sendMTFAlert(marketState);
    prevMTFAligned=marketState.mtf.aligned;
    if (marketState.vix>20&&!vixAlertSent) { vixAlertSent=true; await sendVIXAlert(marketState.vix,marketState.vixNote); }
    if (marketState.vix<=20) vixAlertSent=false;
}

async function updatePrice(price, change, changePct, source) {
    const indicators=processIndicators(price);
    const { signal, confidence, reasons }=combineSignals(indicators);
    marketState.nifty=price; marketState.change=change; marketState.changePct=changePct;
    marketState.signal=signal; marketState.confidence=confidence;
    marketState.rsi=indicators.rsi; marketState.ema9=indicators.ema9;
    marketState.ema21=indicators.ema21; marketState.vwap=indicators.vwap;
    marketState.reason=reasons; marketState.lastUpdated=new Date().toISOString();
    marketState.connected=true; marketState.source=source; marketState.dataPoints=indicators.priceCount;
    if (source==='yahoo') console.log(`NIFTY:${price} RSI:${indicators.rsi||'--'} → ${signal}(${confidence}%)`);
    await checkTelegramAlerts(signal);
    prevSignal=signal;
}

function onTick(tickData) {
    const price=tickData.price; if(!price||price<=0) return;
    const prev=marketState.nifty||price, change=parseFloat((price-prev).toFixed(2));
    const chgPct=prev>0?parseFloat(((change/prev)*100).toFixed(2)):0;
    updatePrice(price,change,chgPct,'websocket');
}

async function refreshMarketData() {
    const { niftyData, vixData }=await fetchMarketData();
    if (niftyData?.closes?.length>0&&!historyLoaded) { initializeHistory(niftyData.closes,niftyData.candles); historyLoaded=true; console.log(`History: ${niftyData.closes.length} candles`); }
    if (vixData) { marketState.vix=vixData.vix; marketState.vixChange=vixData.change; marketState.vixSignal=vixData.signal; marketState.vixNote=vixData.note; marketState.strikeRange=vixData.strikeRange; }
    if (niftyData?.price>0) {
        if (marketState.source!=='websocket') await updatePrice(niftyData.price,niftyData.change,niftyData.changePct,'yahoo');
        else { marketState.change=niftyData.change; marketState.changePct=niftyData.changePct; }
    }
}

async function refreshMTF() { try { const d=await analyzeMultiTimeframe(); if(d) marketState.mtf={signal:d.mtfSignal,strength:d.mtfStrength,confidence:d.mtfConfidence,aligned:d.aligned,bullCount:d.bullCount,bearCount:d.bearCount,tf5m:d.tf5m,tf15m:d.tf15m,tf1h:d.tf1h}; } catch(e) { console.error('MTF:',e.message); } }
async function refreshGlobal() { try { const g=await fetchGlobalCues(); if(g) marketState.global=g; } catch(e) { console.error('Global:',e.message); } }
async function refreshBreadth() { try { const d=await fetchAdvanceDecline(); if(d) marketState.breadth=d; } catch(e) { console.error('Breadth:',e.message); } }
async function refreshSR() { try { if(marketState.nifty>0) { const sr=await calculateSRLevels(marketState.nifty); if(sr) marketState.srLevels=sr; } } catch(e) { console.error('SR:',e.message); } }

// ── Trade journal helpers ─────────────────────────────
function getTradeSummary() {
    const closed = trades.filter(t=>t.status==='CLOSED');
    const totalPnl = closed.reduce((s,t)=>s+(t.pnl||0), 0);
    const winners  = closed.filter(t=>t.pnl>0).length;
    const losers   = closed.filter(t=>t.pnl<0).length;
    const winRate  = (winners+losers)>0 ? Math.round((winners/(winners+losers))*100) : 0;
    const openPnl  = trades.filter(t=>t.status==='OPEN'&&t.currentPnl!=null).reduce((s,t)=>s+(t.currentPnl||0),0);
    return { totalPnl, openPnl, winners, losers, winRate, totalTrades:trades.length, openTrades:trades.filter(t=>t.status==='OPEN').length };
}

// Update open trade MTM P&L
function updateOpenTradesMTM() {
    const price = marketState.nifty;
    if (!price) return;
    trades.filter(t=>t.status==='OPEN').forEach(t=>{
        // Rough MTM based on Nifty move (simplified)
        // In real scenario we'd track live premium
        t.niftyCurrent = price;
        t.niftyMove    = parseFloat((price - (t.niftyAtEntry||price)).toFixed(0));
    });
}

// ── Routes ────────────────────────────────────────────
app.get('/api/signal',  (req,res) => { updateOpenTradesMTM(); res.json(marketState); });
app.get('/api/candles', (req,res) => res.json(getCandleHistory()));

// Chart historical data — fetched server-side to avoid browser CORS restrictions
app.get('/api/chart', async (req,res) => {
    const tf = req.query.tf || '5m';
    const intervalMap = { '5m':'5m', '15m':'15m', '1h':'60m' };
    const rangeMap    = { '5m':'5d', '15m':'5d', '1h':'1mo' };
    const interval = intervalMap[tf] || '5m';
    const range    = rangeMap[tf]    || '5d';
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=${interval}&range=${range}&includePrePost=false`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        const q = response.data?.chart?.result?.[0]?.indicators?.quote?.[0];
        if (!q) return res.json([]);
        const { open, high, low, close, volume } = q;
        const candles = [];
        for (let i = 0; i < close.length; i++) {
            if (close[i] != null && high[i] != null && low[i] != null) {
                candles.push({ open: open[i] || close[i], high: high[i], low: low[i], close: close[i], volume: volume[i] || 1 });
            }
        }
        res.json(candles);
    } catch (err) {
        console.error('Chart API error:', err.message);
        res.json([]);
    }
});
app.get('/api/global',  (req,res) => res.json(marketState.global));
app.get('/api/breadth', (req,res) => res.json(marketState.breadth));
app.get('/api/levels',  (req,res) => res.json(marketState.srLevels));

app.get('/api/health',  (req,res) => res.json({
    status:marketState.connected?'live':'waiting',
    nifty:marketState.nifty, vix:marketState.vix,
    globalBias:marketState.global.bias,
    advances:marketState.breadth.advances,
    declines:marketState.breadth.declines,
    telegram:isConfigured()?'configured':'not configured',
    source:marketState.source
}));

// PCR
app.post('/api/pcr', (req,res) => {
    const {pcr,atmPcr}=req.body;
    if(pcr!=null)    { marketState.pcr=parseFloat(pcr);    marketState.pcrSignal=pcrLabel(marketState.pcr);    trackPCRHistory(marketState.pcr); }
    if(atmPcr!=null) { marketState.atmPcr=parseFloat(atmPcr); marketState.atmPcrSignal=pcrLabel(marketState.atmPcr); }
    res.json({success:true});
});

// FII DII
app.post('/api/fiidii', (req,res) => {
    const {fiiBuy,fiiSell,diiBuy,diiSell}=req.body;
    if(fiiBuy!=null&&fiiSell!=null) marketState.fii={buy:parseFloat(fiiBuy),sell:parseFloat(fiiSell),net:parseFloat((fiiBuy-fiiSell).toFixed(2))};
    if(diiBuy!=null&&diiSell!=null) marketState.dii={buy:parseFloat(diiBuy),sell:parseFloat(diiSell),net:parseFloat((diiBuy-diiSell).toFixed(2))};
    res.json({success:true});
});

// Option Flow
app.post('/api/optionflow', (req,res) => {
    const {atmCE,atmPE}=req.body;
    updateOptionFlow(atmCE?parseFloat(atmCE):null, atmPE?parseFloat(atmPE):null);
    res.json({success:true, dominance:marketState.optionFlow.dominance});
});

// ── TRADE JOURNAL ─────────────────────────────────────
app.post('/api/trade/add', (req,res) => {
    const {type,strike,premium,lots,sl,notes}=req.body;
    const ist=getIST();
    const time=`${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    const trade = {
        id:tradeCounter++, time, type, strike:parseInt(strike),
        premium:parseFloat(premium), lots:parseInt(lots)||1,
        sl:parseFloat(sl)||0, exitPremium:null, pnl:null,
        status:'OPEN', notes:notes||'',
        niftyAtEntry:marketState.nifty,
        niftyCurrent:marketState.nifty, niftyMove:0
    };
    trades.push(trade);
    console.log(`📔 Trade: ${type} ${strike} @₹${premium} × ${lots}lots`);
    res.json({success:true, trade});
});

app.post('/api/trade/exit', (req,res) => {
    const {id,exitPremium}=req.body;
    const trade=trades.find(t=>t.id===id);
    if(!trade) return res.json({success:false,msg:'Not found'});
    trade.exitPremium=parseFloat(exitPremium);
    trade.pnl=parseFloat(((trade.exitPremium-trade.premium)*trade.lots*65).toFixed(0));
    trade.status='CLOSED';
    const ist=getIST();
    trade.exitTime=`${String(ist.getHours()).padStart(2,'0')}:${String(ist.getMinutes()).padStart(2,'0')}`;
    console.log(`📔 Exit: P&L ${trade.pnl>=0?'+':''}₹${trade.pnl}`);
    res.json({success:true, trade});
});

app.delete('/api/trade/:id', (req,res) => {
    trades=trades.filter(t=>t.id!==parseInt(req.params.id));
    res.json({success:true});
});

app.get('/api/trades', (req,res) => {
    res.json({ trades:[...trades].reverse(), summary:getTradeSummary() });
});

// ── EVENTS CALENDAR ───────────────────────────────────
app.post('/api/event', (req,res) => {
    const {time,title,impact}=req.body;
    events.push({id:Date.now(),time,title,impact:impact||'medium'});
    events.sort((a,b)=>a.time.localeCompare(b.time));
    res.json({success:true});
});

app.get('/api/events', (req,res) => res.json(events));

app.delete('/api/event/:id', (req,res) => {
    events=events.filter(e=>e.id!==parseInt(req.params.id));
    res.json({success:true});
});

// Telegram test
app.post('/api/telegram/test', async (req,res) => {
    if(!isConfigured()) return res.json({success:false,msg:'Not configured'});
    await sendMorningSummary(marketState);
    res.json({success:true,msg:'Test sent!'});
});

app.get('/', (req,res) => res.sendFile(__dirname+'/public/index.html'));

// Serve stub sw.js + manifest so PWA requests don't 404
app.get('/sw.js', (req,res) => { res.setHeader('Content-Type','application/javascript'); res.send('// Service Worker stub'); });
app.get('/manifest.json', (req,res) => res.json({ name:'VardaanNifty AI', short_name:'VNifty', start_url:'/', display:'standalone', background_color:'#020508', theme_color:'#00ff88', icons:[] }));

// ── Init ──────────────────────────────────────────────
async function initializeLiveData() {
    console.log('Starting VardaanNifty AI...');
    console.log('Telegram:', isConfigured()?'✅':'❌');
    await Promise.all([refreshMarketData(), refreshGlobal(), refreshBreadth()]);
    await Promise.all([refreshMTF(), refreshSR()]);
    setInterval(refreshMarketData, 3*60*1000);
    setInterval(refreshMTF,        5*60*1000);
    setInterval(refreshGlobal,     5*60*1000);
    setInterval(refreshBreadth,    3*60*1000);
    setInterval(refreshSR,        10*60*1000);
    const auth=await loginAngel();
    if(auth) { console.log('Angel Login Success'); startWebSocket(auth,onTick); }
    else     { console.log('Yahoo Finance fallback'); setTimeout(initializeLiveData,30000); }
}

initializeLiveData();
server.listen(PORT, () => {
    console.log(`VardaanNifty AI running on port ${PORT}`);
    server.keepAliveTimeout = 120000;
    server.headersTimeout   = 125000;
});
