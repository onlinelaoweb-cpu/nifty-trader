const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Check if configured ───────────────────────────────
function isConfigured() {
    return BOT_TOKEN && CHAT_ID;
}

// ── Send message ──────────────────────────────────────
async function sendMessage(text) {
    if (!isConfigured()) {
        console.warn('⚠️  Telegram not configured — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing. Message NOT sent:', text.substring(0, 50));
        return;
    }

    try {
        const res = await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id   : CHAT_ID,
                text      : text,
                parse_mode: 'HTML'
            },
            { timeout: 8000 }
        );

        // Telegram can return HTTP 200 with { ok: false } on bad chat_id, blocked bot,
        // bad HTML markup, etc — axios won't throw on that, so check the body explicitly.
        if (res.data && res.data.ok === true) {
            const chatTitle = res.data.result?.chat?.title || res.data.result?.chat?.username || res.data.result?.chat?.id;
            console.log(`📱 Telegram sent → chat:${chatTitle} msgId:${res.data.result?.message_id} | ${text.substring(0, 50)}...`);
        } else {
            console.error('❌ Telegram rejected message (ok:false):', JSON.stringify(res.data), '| chat_id used:', CHAT_ID, '| text:', text.substring(0, 80));
        }
    } catch (err) {
        // err.response.data carries Telegram's actual error description (e.g. "chat not found",
        // "bot was blocked by the user", "Bad Request: can't parse entities") — log it explicitly.
        const tgError = err.response?.data;
        console.error('❌ Telegram send failed:', err.message, tgError ? '| Telegram says: ' + JSON.stringify(tgError) : '', '| chat_id used:', CHAT_ID);
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
    const emoji      = state.mtf.signal === 'BUY CALL' ? '🟢' : '🔴';
    const validCount     = state.mtf.validTFCount ?? 3;
    const oneHourLagging = state.mtf.oneHourLagging ?? false;
    // Honest title: show exact situation
    const alignTitle = oneHourLagging
        ? '⚡ SIGNAL — 2/3 TFs ALIGNED (1H lagging — reversed)'
        : validCount === 3
            ? '🔥 STRONG SIGNAL — ALL 3 ALIGNED!'
            : `⚡ SIGNAL — ${validCount}/3 TFs ALIGNED (15m warming up)`;

    const msg = `
${alignTitle}
━━━━━━━━━━━━━━━━━━
${emoji} <b>${state.mtf.signal}</b> — ${state.mtf.strength}
📊 NIFTY: ${state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2})}
🎯 Strike: ${state.nifty > 0 ? (Math.round(state.nifty / 50) * 50) + (state.mtf.signal === 'BUY PUT' ? ' PE' : ' CE') : 'ATM'} (ATM)
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

// ── Nishanebaaz Window Alert (14:00–14:30) ───────────────────────────────────
// Proactive alert at 14:00 IST — prime scalping window per Murarka strategy.
// Sent once per day; the caller (server.js) guards the one-shot flag.
async function sendNishanebaazAlert(state) {
    const emoji = state.signal === 'BUY CALL' ? '🟢'
                : state.signal === 'BUY PUT'  ? '🔴'
                : '🟡';

    const signalLine = state.signal !== 'WAIT'
        ? `${emoji} Active signal: <b>${state.signal}</b> (${state.confidence}% confidence)`
        : '🟡 No active signal — watch for breakout';

    const msg = `
⚡ <b>NISHANEBAAZ WINDOW OPEN — 14:00–14:30</b>
━━━━━━━━━━━━━━━━━━
📊 NIFTY: ${state.nifty > 0 ? state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '--'}

${signalLine}

⚠️ High-probability scalp zone — reduce position size
🎯 Theta decay starting: target quick 30–40% premium gain
❌ Avoid holding past 14:30
━━━━━━━━━━━━━━━━━━
<i>VardaanNifty AI — Murarka Strategy</i>
`.trim();

    await sendMessage(msg);
}

// ── Raw message passthrough (for calendar event alerts) ───────────────────────
async function sendRawMessage(text) {
    await sendMessage(text);
}

module.exports = {
    sendSignalAlert,
    sendMTFAlert,
    sendMorningSummary,
    sendVIXAlert,
    sendCloseSummary,
    sendExitAlert,
    sendNishanebaazAlert,
    sendRawMessage,
    isConfigured
};