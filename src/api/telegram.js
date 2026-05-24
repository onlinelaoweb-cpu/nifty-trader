const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Check if configured ───────────────────────────────
function isConfigured() {
    return BOT_TOKEN && CHAT_ID;
}

// ── Send message ──────────────────────────────────────
async function sendMessage(text) {
    if (!isConfigured()) return;

    try {
        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id   : CHAT_ID,
                text      : text,
                parse_mode: 'HTML'
            },
            { timeout: 8000 }
        );
        console.log('📱 Telegram sent:', text.substring(0, 50) + '...');
    } catch (err) {
        console.error('Telegram error:', err.message);
    }
}

// ── Signal Change Alert ───────────────────────────────
async function sendSignalAlert(state, prevSignal) {
    const emoji = state.signal === 'BUY CALL' ? '🟢'
                : state.signal === 'BUY PUT'  ? '🔴'
                : '🟡';

    const vixInfo = state.vix
        ? `VIX: ${state.vix} (${state.vixSignal})`
        : 'VIX: --';

    const pcrInfo = state.pcr
        ? `PCR: ${state.pcr} (${state.pcrSignal})`
        : 'PCR: Manual needed';

    const rsiInfo = state.rsi
        ? `RSI: ${state.rsi}`
        : 'RSI: --';

    const vwapInfo = state.vwap
        ? `VWAP: ${state.vwap.toLocaleString('en-IN')}`
        : 'VWAP: --';

    const strikeInfo = state.strikeRange || 'ATM ±200';

    const mtfInfo = state.mtf?.aligned
        ? '🔥 ALL 3 TIMEFRAMES ALIGNED!'
        : `MTF: ${state.mtf?.bullCount || 0}/3 Bullish`;

    const msg = `
${emoji} <b>SIGNAL CHANGED!</b>
━━━━━━━━━━━━━━━━━━
📊 <b>NIFTY:</b> ${state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2})}
${state.change >= 0 ? '▲' : '▼'} ${Math.abs(state.change).toFixed(2)} (${state.changePct.toFixed(2)}%)

⚡ <b>SIGNAL: ${state.signal}</b>
📈 Confidence: ${state.confidence}%

🎯 Strike Zone: ${strikeInfo}
━━━━━━━━━━━━━━━━━━
${rsiInfo}
${vwapInfo}
${vixInfo}
${pcrInfo}
━━━━━━━━━━━━━━━━━━
${mtfInfo}
━━━━━━━━━━━━━━━━━━
⏰ ${new Date().toLocaleTimeString('en-IN', { hour12: true })}
<i>VardaanNifty AI</i>
`.trim();

    await sendMessage(msg);
}

// ── MTF All Aligned Alert ─────────────────────────────
async function sendMTFAlert(state) {
    const emoji = state.mtf.signal === 'BUY CALL' ? '🟢' : '🔴';

    const msg = `
🔥 <b>STRONG SIGNAL — ALL 3 ALIGNED!</b>
━━━━━━━━━━━━━━━━━━
${emoji} <b>${state.mtf.signal}</b> — ${state.mtf.strength}
📊 NIFTY: ${state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2})}
🎯 Strike: ${state.strikeRange}
📈 Confidence: ${state.mtf.confidence}%
━━━━━━━━━━━━━━━━━━
5 MIN  : ${state.mtf.tf5m?.signal  || '--'}
15 MIN : ${state.mtf.tf15m?.signal || '--'}
1 HOUR : ${state.mtf.tf1h?.signal  || '--'}
━━━━━━━━━━━━━━━━━━
⏰ ${new Date().toLocaleTimeString('en-IN', { hour12: true })}
<i>VardaanNifty AI</i>
`.trim();

    await sendMessage(msg);
}

// ── Morning Market Summary ────────────────────────────
async function sendMorningSummary(state) {
    const msg = `
🌅 <b>MARKET OPEN — Morning Summary</b>
━━━━━━━━━━━━━━━━━━
📊 NIFTY: ${state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2})}
${state.change >= 0 ? '▲' : '▼'} ${Math.abs(state.change).toFixed(2)} (${state.changePct.toFixed(2)}%)

⚡ VIX: ${state.vix || '--'} — ${state.vixSignal || '--'}
🎯 Strike Zone: ${state.strikeRange || 'ATM ±200'}

5 MIN  : ${state.mtf?.tf5m?.signal  || 'Loading...'}
15 MIN : ${state.mtf?.tf15m?.signal || 'Loading...'}
1 HOUR : ${state.mtf?.tf1h?.signal  || 'Loading...'}

📌 Enter PCR on dashboard:
web-production-886aa.up.railway.app
━━━━━━━━━━━━━━━━━━
<i>VardaanNifty AI — Good luck today!</i>
`.trim();

    await sendMessage(msg);
}

// ── VIX High Alert ────────────────────────────────────
async function sendVIXAlert(vix, note) {
    const msg = `
⚠️ <b>VIX ALERT — HIGH VOLATILITY!</b>
━━━━━━━━━━━━━━━━━━
India VIX: <b>${vix}</b>
Status: ${note}

🛡️ Reduce position size!
❌ Avoid far OTM options
━━━━━━━━━━━━━━━━━━
<i>VardaanNifty AI</i>
`.trim();

    await sendMessage(msg);
}

// ── Market Close Summary ──────────────────────────────
async function sendCloseSummary(state) {
    const msg = `
🔔 <b>MARKET CLOSED — End of Day</b>
━━━━━━━━━━━━━━━━━━
📊 NIFTY Close: ${state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2})}
${state.change >= 0 ? '▲' : '▼'} ${Math.abs(state.change).toFixed(2)} (${state.changePct.toFixed(2)}%)

VIX: ${state.vix || '--'}
RSI: ${state.rsi || '--'}
━━━━━━━━━━━━━━━━━━
<i>VardaanNifty AI — See you tomorrow!</i>
`.trim();

    await sendMessage(msg);
}

// ── Exit Alert (SL / Target hit) ──────────────────────
// Called when a live premium crosses a stop-loss or target threshold.
// trade        : the trade object from the trades[] array
// reason       : 'STOP_LOSS' | 'TARGET_1R' | 'TARGET_1_5R'
// currentPremium : latest live ATM premium (from optionFlow)
async function sendExitAlert(trade, reason, currentPremium) {
    const pnlPerLot = parseFloat(((currentPremium - trade.premium) * 65).toFixed(0));
    const totalPnl  = pnlPerLot * trade.lots;
    const pnlSign   = totalPnl >= 0 ? '+' : '';
    const changePct = parseFloat(((currentPremium - trade.premium) / trade.premium * 100).toFixed(1));

    let emoji, heading, action;
    if (reason === 'STOP_LOSS') {
        emoji   = '🛑';
        heading = 'STOP-LOSS HIT';
        action  = 'EXIT NOW — cut loss';
    } else if (reason === 'TARGET_1_5R') {
        emoji   = '🎯';
        heading = 'TARGET 1:1.5 HIT';
        action  = 'Book full profit or trail SL';
    } else {
        emoji   = '✅';
        heading = 'TARGET 1:1 HIT';
        action  = 'Book 50–75% or move SL to cost';
    }

    const msg = `
${emoji} <b>${heading}</b>
━━━━━━━━━━━━━━━━━━
📋 Trade: ${trade.type} ${trade.strike} × ${trade.lots} lot${trade.lots > 1 ? 's' : ''}
⏰ Entry Time: ${trade.time}

💰 Entry Premium : ₹${trade.premium}
📉 Current Premium: ₹${currentPremium} (${changePct > 0 ? '+' : ''}${changePct}%)
━━━━━━━━━━━━━━━━━━
P&L : ${pnlSign}₹${Math.abs(totalPnl)} (${pnlSign}₹${Math.abs(pnlPerLot)}/lot)
━━━━━━━━━━━━━━━━━━
⚡ <b>Action: ${action}</b>
⏰ ${new Date().toLocaleTimeString('en-IN', { hour12: true })}
<i>VardaanNifty AI</i>
`.trim();

    await sendMessage(msg);
}

module.exports = {
    sendSignalAlert,
    sendMTFAlert,
    sendMorningSummary,
    sendVIXAlert,
    sendCloseSummary,
    sendExitAlert,
    isConfigured
};
