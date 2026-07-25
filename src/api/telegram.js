const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Check if configured ───────────────────────────────
function isConfigured() {
    return BOT_TOKEN && CHAT_ID;
}

// ── HTML sanitizer for Telegram parse_mode:'HTML' ─────────────────────────
// BUG FOUND (23 July, from production logs): a literal '<' inside generated
// label text — e.g. ORB's "Broken Down (<23825)" or PCR's "0.65 < 0.75" —
// gets sent as-is under parse_mode:'HTML'. Telegram's parser reads "<23825"
// as an attempted tag and rejects the WHOLE message: "Bad Request: can't
// parse entities: Unsupported start tag". The alert silently fails to send.
// Fixed the two known label sources, but adding this as a permanent net so
// the entire bug class can't recur from some other label text later: shield
// our own small set of intentional tags behind placeholders, escape every
// other stray < and >, then restore the real tags.
const ALLOWED_TAG_RE = /<\/?(?:b|i|u|code|pre)>/gi;
function sanitizeForTelegramHTML(text) {
    const shielded = [];
    let out = text.replace(ALLOWED_TAG_RE, (match) => {
        shielded.push(match);
        return `\u0000${shielded.length - 1}\u0000`;
    });
    out = out.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => shielded[parseInt(i, 10)]);
    return out;
}

// ── Send message ──────────────────────────────────────
async function sendMessage(text) {
    if (!isConfigured()) {
        console.warn('⚠️  Telegram not configured — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing. Message NOT sent:', text.substring(0, 50));
        return;
    }

    const safeText = sanitizeForTelegramHTML(text);

    try {
        const res = await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id   : CHAT_ID,
                text      : safeText,
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
async function sendSignalAlert(state, prevSignal, strikeData = null) {
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

    // Volume info — prefer RVOL (decision-relevant: "is this move on real volume?")
    // over the old raw session cumulative number, which told the reader nothing
    // about whether today's volume was high or low (23 July audit: too many
    // raw numbers without context). Falls back to session total if RVOL isn't
    // available yet (Yahoo fallback mode, or <5 candles of history).
    const rvolData = state.volumeRVOL;
    const volInfo = rvolData?.reliable
        ? `📦 Volume: ${rvolData.rvol}x average${rvolData.rvol >= 2.0 ? ' — spike ⚡' : ''}`
        : state.wsVolume > 0
            ? `📦 Volume: ${(state.wsVolume / 1e6).toFixed(2)}M (session)`
            : null;  // omit entirely if no volume data at all

    // FIX: old label only showed bullCount regardless of signal direction —
    // produced "SIGNAL: BUY CALL ... MTF: 0/3 Bullish" which looks contradictory.
    // Now shows both counts and flags when the signal disagrees with MTF
    // (this happens because combineSignals() is a separate multi-factor system
    // — RSI/EMA/VWAP/PCR/breadth — that can diverge from the MTF vote; that's
    // by design, but the message should say so instead of looking like a bug).
    const mtfBull = state.mtf?.bullCount || 0;
    const mtfBear = state.mtf?.bearCount || 0;
    const mtfDisagrees =
        (state.signal === 'BUY CALL' && mtfBear > mtfBull) ||
        (state.signal === 'BUY PUT'  && mtfBull > mtfBear);
    const mtfInfo = state.mtf?.aligned
        ? '🔥 ALL 3 TIMEFRAMES ALIGNED!'
        : mtfDisagrees
            ? `⚠️ MTF: ${mtfBull}↑ ${mtfBear}↓ — signal from other factors (RSI/PCR/breadth), not MTF`
            : `MTF: ${mtfBull}/3 Bullish, ${mtfBear}/3 Bearish`;

    // POC info — show POC level and whether price is on right side
    const pocData  = state.poc;
    const pocEmoji = !pocData || pocData.signal === 'INSUFFICIENT' ? '⏳'
                   : pocData.signal === 'AT_POC'    ? '🟡'
                   : pocData.signal === 'ABOVE_POC' ? '🟢'
                   :                                   '🔴';
    const pocInfo  = pocData?.poc
        ? `${pocEmoji} POC:${pocData.poc} | VAH:${pocData.vah} | VAL:${pocData.val} (${pocData.signal.replace('_',' ')})`
        : '⏳ POC — warming up';

    // Delta info — show pressure + divergence warning if present
    const deltaData = state.delta;
    const deltaEmoji = !deltaData ? '⏳'
                     : deltaData.divergence      ? '⚠️'
                     : deltaData.signal === 'BULLISH' ? '🟢'
                     : deltaData.signal === 'BEARISH' ? '🔴'
                     :                                   '⚪';
    const deltaInfo = deltaData?.deltaPct !== undefined
        ? `${deltaEmoji} Delta:${deltaData.deltaPct > 0 ? '+' : ''}${deltaData.deltaPct}% (${deltaData.signal})${deltaData.divergence ? ' — REVERSAL WARNING' : ''}${deltaData.source === 'websocket' ? ' [live]' : ' [proxy]'}`
        : '⏳ Delta — warming up (WS buyQty/sellQty not yet received)';

    // ── Strike SL / Target block ─────────────────────────────────────────────
    // If pickStrikeAndPremium computed a strike, show it with entry/SL/target.
    // Lot size 75 for Nifty — show per-lot P&L for quick mental math.
    const LOT = 65;  // FIX: Nifty lot size revised Jan 2026 by NSE: 75 → 65
    let strikeBlock = '';
    if (strikeData && strikeData.entry > 0) {
        const slPct    = ((strikeData.entry - strikeData.sl) / strikeData.entry * 100).toFixed(0);
        const tgtPct   = ((strikeData.target - strikeData.entry) / strikeData.entry * 100).toFixed(0);
        const slLoss   = Math.round((strikeData.entry - strikeData.sl) * LOT);
        const tgtGain  = Math.round((strikeData.target - strikeData.entry) * LOT);
        const stalenessNote = (strikeData.premiumAgeSec != null && strikeData.premiumAgeSec > 90)
            ? ` ⚠️ (quote ${Math.round(strikeData.premiumAgeSec/60)}min old — verify on broker before entry)`
            : '';
        strikeBlock = `💰 <b>${strikeData.strike} ${strikeData.type}</b>
📥 Entry : ₹${strikeData.entry}${stalenessNote}
🎯 Target: ₹${strikeData.target} (+${tgtPct}% | +₹${tgtGain}/lot)
🛑 SL    : ₹${strikeData.sl} (-${slPct}% | -₹${slLoss}/lot)
📊 R:R   : 1:2${strikeData.slSource?.startsWith('fibo') ? '\n📐 SL basis: swing structure (Physics Law-3)' : ''}${strikeData.bep ? `\n⚖️ BEP    : ${strikeData.bep} (Nifty needs ${strikeData.type === 'CE' ? 'to reach' : 'to fall to'} this by expiry to break even)` : ''}`;

        // ── AI Trade Coach block — entry-zone + staged profit plan ───────────
        const coach = strikeData.coach;
        if (coach) {
            strikeBlock += `\n\n🧑‍🏫 <b>AI Trade Coach</b>
✅ Ideal Entry: ${coach.idealEntryLabel}
⚠️ ${coach.chaseWarning}
💡 ${coach.ifMissed}
📈 +20% → ${coach.plan[0].action}
📈 +30% → ${coach.plan[1].action}
📈 +40% → ${coach.plan[2].action}`;
        }
    } else {
        // strikeData is null when: (a) no VIX available yet, or (b) PCR premiums not loaded
        // Give actionable guidance instead of just showing ATM
        strikeBlock = state.vix
            ? `🎯 ATM ${Math.round((state.nifty||0)/50)*50} ${state.signal==='BUY CALL'?'CE':'PE'} | SL: -25% premium | Target: +50% (1:2 R:R)`
            : '⏳ Strike data loading (VIX pending) — use ATM, SL -20%';
    }

    const msg = `
${emoji} <b>SIGNAL CHANGED!</b>
━━━━━━━━━━━━━━━━━━
📊 <b>NIFTY:</b> ${state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2})}
${state.change >= 0 ? '▲' : '▼'} ${Math.abs(state.change).toFixed(2)} (${state.changePct.toFixed(2)}%)

⚡ <b>SIGNAL: ${state.signal}</b>
📈 Confidence: ${state.confidence}%${state.tradeQuality ? ` | Grade: ${state.tradeQuality.grade} (${state.tradeQuality.sizeHint})` : ''}
${(() => {
    // ── Engine Checklist — highest-priority feature from both audits ────────
    // "Immediately users know why." Directly reflects qualityGate, so it can
    // never say something different from what actually gated this signal.
    const cl = state.engineChecklist;
    if (!cl || !cl.items?.length) return '';
    const lines = cl.items.map(i => `${i.passed ? '✅' : '❌'} ${i.label}`).join('\n');
    return `\n📋 <b>ENGINE CHECKLIST</b>\n${lines}\n<b>${cl.summary}</b>\n`;
})()}
🎯 Strike Zone: ${strikeInfo}
━━━━━━━━━━━━━━━━━━
${rsiInfo}
${vwapInfo}
${vixInfo}
${pcrInfo}${volInfo ? '\n' + volInfo : ''}
━━━━━━━━━━━━━━━━━━
${pocInfo}
${deltaInfo}
${state.orb?.label ? '\n' + state.orb.label : ''}
${state.dynamicLevels?.available ? `\n📐 ${state.dynamicLevels.label}` : ''}
${state.premarketGap?.available ? `\n${state.premarketGap.label}` : ''}
${(state.eventCountdown?.available && state.eventCountdown.withinCautionWindow) ? `\n${state.eventCountdown.label}` : ''}
${state.newsSentiment?.available ? `\n${state.newsSentiment.label}` : ''}
${state.smartMoney && state.smartMoney.bias !== 'NEUTRAL' ? `\n${state.smartMoney.label}` : ''}
${state.physicsOfTrading?.bosChoch?.event && state.physicsOfTrading.bosChoch.event !== 'NONE' ? `\n${state.physicsOfTrading.bosChoch.label}` : ''}
${state.optionGreeks?.available ? `\n${state.optionGreeks.label}` : ''}
${state.marketRegime && !state.marketRegime.tags?.includes('NORMAL') ? `\n${state.marketRegime.label}` : ''}
${state.dataHealth && !state.dataHealth.healthy ? `\n${state.dataHealth.label}` : ''}
━━━━━━━━━━━━━━━━━━
${strikeBlock}
━━━━━━━━━━━━━━━━━━
${mtfInfo}${state.marketHealth ? `\n📋 Market Health: ${state.marketHealth.total}/100 — ${state.marketHealth.label}` : ''}${state.momentumDecayWarning ? `\n${state.momentumDecayWarning}` : ''}
${(() => {
    // ── Trend Conviction diagnostic — audit trail for contradiction cases ──
    // Added after a Friday session where a BUY PUT fired while VWAP/Delta/ORB/
    // 15m all looked bullish — impossible to verify after the fact from the
    // Telegram message alone whether Trend Conviction actually evaluated this
    // as opposing (and was overridden) or genuinely didn't reach the 4/6
    // threshold at that tick. This line makes it directly checkable next time
    // instead of requiring after-the-fact inference from other message fields.
    const tc = state.trendConviction;
    if (!tc || !tc.active) return '';
    const oppose = (tc.active === 'BEARISH' && state.signal === 'BUY CALL') ||
                   (tc.active === 'BULLISH' && state.signal === 'BUY PUT');
    if (!oppose) return '';
    const conds = tc.active === 'BEARISH' ? tc.bearConditions : tc.bullConditions;
    return `\n🔍 Trend Conviction: ${tc.active} (${conds.length}/6: ${conds.join(', ')}) — convictionOk=${state.qualityGate?.convictionOk}`;
})()}
━━━━━━━━━━━━━━━━━━
⏰ ${new Date().toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' })}
<i>VardaanNifty AI</i>
`.trim();

    await sendMessage(msg);
}

// ── MTF All Aligned Alert ─────────────────────────────
async function sendMTFAlert(state, strikeData = null) {
    const emoji      = state.mtf.signal === 'BUY CALL' ? '🟢' : '🔴';
    const validCount     = state.mtf.validTFCount ?? 3;
    const oneHourLagging = state.mtf.oneHourLagging ?? false;
    // Honest title: show exact situation
    const alignTitle = oneHourLagging
        ? '⚡ SIGNAL — 2/3 TFs ALIGNED (1H lagging — reversed)'
        : validCount === 3
            ? '🔥 STRONG SIGNAL — ALL 3 ALIGNED!'
            : `⚡ SIGNAL — ${validCount}/3 TFs ALIGNED (15m warming up)`;

    const LOT = 65;  // Nifty lot size, revised Jan 2026: 75 → 65
    const lq = strikeData?.leadQuality;

    // ── Main-engine status (unchanged logic) ─────────────────────────────────
    const mainConfirms = state.signal === state.mtf.signal;

    // ── Plain-English verdict — leads the message so the reader doesn't have
    // to parse jargon to know what to do. Tiered off the same mainConfirms /
    // leadQuality data that already existed, just surfaced up front instead
    // of buried after 15 lines of technical fields.
    const verdictLine = mainConfirms && state.tradeQuality
        ? `✅ <b>TAKE — main engine confirms this trade right now</b> (Grade ${state.tradeQuality.grade}, ${state.tradeQuality.sizeHint})`
        : lq?.label === 'Strong Confluence'
            ? `🟡 <b>WATCH ONLY</b> — strong setup on the MTF tracker, but the main engine still says WAIT. Size down or skip until it confirms.`
            : lq?.label === 'Moderate'
                ? `🟠 <b>WEAK</b> — only partial confluence. Skip unless you have your own confirmation.`
                : `⚪ <b>LOW CONVICTION</b> — treat as background noise, no action needed.`;

    // ── "Main Engine blocked by" — requested independently across three audits
    // (17 Jul, and three separate times on 25 Jul: "show exactly what is
    // preventing the main engine from confirming" / "Pending confirmations" /
    // "Waiting For"). Not a new calculation — engineChecklist is already
    // computed live on every tick regardless of whether a trade actually
    // fires, so this just surfaces what already exists instead of leaving
    // "main engine still says WAIT" unexplained. Only shown when NOT already
    // confirmed, and only lists the failing checks (not all 11) to stay short.
    let blockedByLine = '';
    if (!mainConfirms && state.engineChecklist?.items?.length) {
        const failing = state.engineChecklist.items.filter(i => !i.passed);
        if (failing.length) {
            blockedByLine = `\n🔒 <b>Main Engine blocked by:</b> ${failing.map(i => i.label).join(', ')} (${state.engineChecklist.summary})`;
        }
    }

    // ── Range-pocket / structure warning — same label the Insights tab and
    // sendSignalAlert already use (src/api/dynamicLevels.js), but this alert
    // type never showed it before. This is the exact context that explained
    // why today's two "Strong Confluence" MTF trades (24000PE @152.3, @157.75)
    // both stalled at +15-19% instead of reaching target — both fired with
    // dyn_zone=INSIDE (a range pocket), which this line now surfaces up front
    // instead of only being visible later in the DB audit.
    const rangeWarning = state.dynamicLevels?.available
        ? `\n📐 ${state.dynamicLevels.label}`
        : '';

    // ── Trade levels — plain numbers first, no jargon ────────────────────────
    let levelsBlock = '';
    let detailsBlock = '';
    if (strikeData && strikeData.entry > 0) {
        const slPct   = ((strikeData.entry - strikeData.sl) / strikeData.entry * 100).toFixed(0);
        const tgtPct  = ((strikeData.target - strikeData.entry) / strikeData.entry * 100).toFixed(0);
        const slLoss  = Math.round((strikeData.entry - strikeData.sl) * LOT);
        const tgtGain = Math.round((strikeData.target - strikeData.entry) * LOT);
        const coach = strikeData.coach;
        const stalenessNote2 = (strikeData.premiumAgeSec != null && strikeData.premiumAgeSec > 90)
            ? ` ⚠️ (quote ${Math.round(strikeData.premiumAgeSec/60)}min old — verify on broker before entry)`
            : '';

        levelsBlock = `💰 <b>${strikeData.strike} ${strikeData.type}</b>
📥 Entry : ₹${strikeData.entry}${stalenessNote2}
🎯 Target: ₹${strikeData.target} (+${tgtPct}% | +₹${tgtGain}/lot)
🛑 SL    : ₹${strikeData.sl} (-${slPct}% | -₹${slLoss}/lot)`;

        const coachBlock = coach
            ? `\n\n🧑‍🏫 <b>AI Trade Coach</b>\n✅ Ideal Entry: ${coach.idealEntryLabel} | ${coach.chaseWarning}\n📈 +20% SL→cost | +30% book 50% | +40% exit`
            : '';
        levelsBlock += coachBlock;

        // ── Details — technical fields moved here, below the actionable info,
        // for anyone who wants to see the full reasoning. Nothing removed,
        // just reordered so it doesn't block the "what do I do" answer.
        const lqEmoji = lq ? (lq.label === 'Strong Confluence' ? '🟢' : lq.label === 'Moderate' ? '🟡' : '🔴') : '';
        const lqLine = lq
            ? `${lqEmoji} Lead Quality: ${lq.label} (${lq.score}/4) — ${[
                lq.isFull3 ? '3/3 TFs' : null,
                lq.deltaMatches ? 'Delta confirms' : null,
                lq.highConf ? 'High confidence' : null,
                lq.mainConfluence ? `Main engine agreed ${lq.mainAgreesMinAgo}m ago` : null,
              ].filter(Boolean).join(', ') || 'no supporting factors — treat as noise'}`
            : '';

        const pocData  = state.poc;
        const pocLine  = pocData?.poc
            ? `POC:${pocData.poc} | VAH:${pocData.vah} | VAL:${pocData.val} (${pocData.signal.replace('_',' ')})`
            : '';
        const deltaData = state.delta;
        const deltaLine = deltaData?.deltaPct !== undefined
            ? `Delta:${deltaData.deltaPct > 0 ? '+' : ''}${deltaData.deltaPct}% (${deltaData.signal})${deltaData.divergence ? ' — REVERSAL WARNING' : ''}`
            : '';
        const rvolLine = state.volumeRVOL?.reliable
            ? `📊 Volume: ${state.volumeRVOL.rvol}x average${state.volumeRVOL.rvol >= 2.0 ? ' — spike ⚡' : ''}`
            : '';

        detailsBlock = `\n🔍 <b>Why this fired</b>
5m: ${state.mtf.tf5m?.signal || '--'} · 15m: ${state.mtf.tf15m?.signal || '--'} · 1H: ${state.mtf.tf1h?.signal || '--'}
${pocLine}
${deltaLine}
${rvolLine}
📊 R:R 1:2${strikeData.slSource?.startsWith('fibo') ? ' (SL basis: swing structure)' : ''}${strikeData.bep ? ` | BEP: ${strikeData.bep}` : ''}
${lqLine}${state.momentumDecayWarning ? `\n${state.momentumDecayWarning}` : ''}`;
    }

    const msg = `
${verdictLine}${blockedByLine}
━━━━━━━━━━━━━━━━━━
${alignTitle}
${emoji} <b>${state.mtf.signal}</b> — ${state.mtf.strength} | NIFTY: ${state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2})}${rangeWarning}
━━━━━━━━━━━━━━━━━━
${levelsBlock}
━━━━━━━━━━━━━━━━━━${detailsBlock}
⏰ ${new Date().toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' })}
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
    // FIX: this used to compute "day change" from TODAY'S OPEN (sessionOpenPrice),
    // while the morning summary and every single intraday alert all along used
    // PREVIOUS DAY'S CLOSE (state.change/state.changePct, powered by the
    // prevClose fix in marketData.js). Those are two different numbers by
    // definition — open-to-close move vs vs-yesterday move — and using the
    // wrong one here made the EOD summary disagree with the broker's own
    // chart and with every earlier message sent the same day. Reverted to
    // state.change/state.changePct as the primary source (same as morning
    // summary), keeping the prevClose-based recomputation only as a guard
    // against the original problem this code was trying to solve: WS ticks
    // going stale right at 15:30 and showing a false 0.00%.
    let dayChange = state.change;
    let dayPct    = state.changePct;
    const looksStale = !dayChange || Math.abs(dayChange) < 0.01;
    if (looksStale && state.prevClose > 0) {
        dayChange = parseFloat((state.nifty - state.prevClose).toFixed(2));
        dayPct    = parseFloat(((dayChange / state.prevClose) * 100).toFixed(2));
    }

    // ── Daily digest — how many signals fired today, and how today's tracked
    // trades resolved. Previously the only way to get this was manually
    // screenshotting the day's Telegram history for an audit; now it's a
    // built-in daily report card.
    const dc = state.dailySignalCounts;
    const digestLines = [];
    if (dc && (dc.main || dc.mtfStrong || dc.mtfModerate || dc.mtfWeak)) {
        digestLines.push(`\n📋 <b>Today's Signals</b>`);
        if (dc.main) digestLines.push(`Main engine: ${dc.main}`);
        if (dc.mtfStrong || dc.mtfModerate || dc.mtfWeak) {
            // Only Strong Confluence leads actually fire an alert (see server.js
            // "sure shot" gating change, 22 Jul) — Moderate/Weak are suppressed
            // silently. Showing all three tiers here (not just the sent ones)
            // so you can see how much the gate is filtering without having to
            // watch the noisy leads yourself.
            const suppressed = dc.mtfModerate + dc.mtfWeak;
            digestLines.push(`MTF-tracker: 🟢${dc.mtfStrong} Strong (sent) · 🟡${dc.mtfModerate} Moderate + 🔴${dc.mtfWeak} Weak (${suppressed} suppressed, not sent)`);
        }
    }
    const perf = state.todaySignalPerf;
    if (perf && perf.total > 0) {
        // Three separate numbers, not one blended one — see getSignalPerformanceSummary()
        // header for why (17 Jul audit: "accuracy: 33%" looked bad on a day that was
        // ~90% directionally correct, purely because target_hit is strict pass/fail).
        digestLines.push(`Closed today: ${perf.total} | Direction: ${perf.directionalAccuracy}% · Target hit: ${perf.accuracy}% · SL hit: ${perf.slRate}%`);
    }
    const digestBlock = digestLines.length ? `\n━━━━━━━━━━━━━━━━━━${digestLines.join('\n')}` : '';

    const msg = `
🔔 <b>MARKET CLOSED — End of Day</b>
━━━━━━━━━━━━━━━━━━
📊 NIFTY Close: ${state.nifty.toLocaleString('en-IN', {minimumFractionDigits: 2})}
${dayChange >= 0 ? '▲' : '▼'} ${Math.abs(dayChange).toFixed(2)} (${dayPct.toFixed(2)}%)

VIX: ${state.vix || '--'}
RSI: ${state.rsi || '--'}${digestBlock}
━━━━━━━━━━━━━━━━━━
<i>VardaanNifty AI — See you tomorrow!</i>
`.trim();

    await sendMessage(msg);
}

// ── Scalp Plan Alert — alternate fast-exit plan, SAME confirmed signal ──────
// Fires right alongside sendSignalAlert() for the exact same trade — not a
// new signal, not a new gate. Deliberately different visual identity (⚡⚡⚡
// border instead of ━━━, no "SIGNAL" wording in the title) so it can never be
// mistaken for a new/separate trade the way tonight's MTF-vs-main confusion
// happened. This is "same trade, here's a quicker way to exit it" — nothing more.
async function sendScalpAlert(state, strikeData, scalpPlan) {
    if (!strikeData || !scalpPlan) return;
    const emoji = state.signal === 'BUY CALL' ? '🟢' : '🔴';

    const msg = `
⚡⚡⚡ SCALP EXIT PLAN ⚡⚡⚡
(same trade as above — optional quick-exit alternative)
⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡
${emoji} <b>${strikeData.strike} ${strikeData.type}</b> @ ₹${scalpPlan.entry}

🎯 Scalp Target: ₹${scalpPlan.scalpTarget} (+${scalpPlan.scalpTgtPct}%)
🛑 Scalp SL    : ₹${scalpPlan.scalpSL} (-${scalpPlan.scalpSlPct}%)

⏱ Review at ${scalpPlan.reviewByLabel} · <b>Hard exit by ${scalpPlan.hardExitByLabel}</b> regardless of P&L

💡 This is NOT a bigger/better target than the main plan above — it's a
smaller, faster one for when you just want in-and-out within 10-20 min
instead of riding the full swing target.
⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡⚡
⏰ ${new Date().toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' })}
<i>VardaanNifty AI</i>
`.trim();

    await sendMessage(msg);
}


// Called when a live premium crosses a stop-loss or target threshold.
// trade        : the trade object from the trades[] array
// reason       : 'STOP_LOSS' | 'TARGET_1R' | 'TARGET_1_5R'
// currentPremium : latest live ATM premium (from optionFlow)
async function sendExitAlert(trade, reason, currentPremium, extra = {}) {
    const pnlPerLot = parseFloat(((currentPremium - trade.premium) * 65).toFixed(0));
    const totalPnl  = pnlPerLot * trade.lots;
    const pnlSign   = totalPnl >= 0 ? '+' : '';
    const changePct = parseFloat(((currentPremium - trade.premium) / trade.premium * 100).toFixed(1));

    let emoji, heading, action;
    if (reason === 'STOP_LOSS') {
        emoji   = '🛑';
        heading = 'STOP-LOSS HIT';
        action  = 'EXIT NOW — cut loss';
    } else if (reason === 'TRAILING_SL') {
        emoji   = '🪜';
        heading = 'TRAILING SL HIT';
        action  = 'EXIT NOW — profit locked in';
    } else if (reason === 'TREND_BREAK') {
        emoji   = '⚠️';
        heading = 'TREND STRUCTURE BROKE (Physics Law-1)';
        action  = 'Consider tightening exit — trend that got you here may be over';
    } else if (reason === 'TARGET_1_5R') {
        emoji   = '🎯';
        heading = 'TARGET 1:1.5 HIT';
        action  = 'Book full profit or trail SL';
    } else {
        emoji   = '✅';
        heading = 'TARGET 1:1 HIT';
        action  = 'Trailing SL now active — winners can run';
    }

    const trailLine = (reason === 'TRAILING_SL' || reason === 'TREND_BREAK') && extra.peak != null
        ? `\n📈 Peak Premium  : ₹${extra.peak}\n🪜 Trail SL      : ₹${extra.trailSL}\n━━━━━━━━━━━━━━━━━━`
        : '';

    const msg = `
${emoji} <b>${heading}</b>
━━━━━━━━━━━━━━━━━━
📋 Trade: ${trade.type} ${trade.strike} × ${trade.lots} lot${trade.lots > 1 ? 's' : ''}
⏰ Entry Time: ${trade.time}

💰 Entry Premium : ₹${trade.premium}
📉 Current Premium: ₹${currentPremium} (${changePct > 0 ? '+' : ''}${changePct}%)${trailLine}
━━━━━━━━━━━━━━━━━━
P&L : ${pnlSign}₹${Math.abs(totalPnl)} (${pnlSign}₹${Math.abs(pnlPerLot)}/lot)
━━━━━━━━━━━━━━━━━━
⚡ <b>Action: ${action}</b>
⏰ ${new Date().toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' })}
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

// ── Spread / Hedging Strategy Alert ──────────────────────────────────────────
async function sendSpreadAlert(spread, state) {
    const legLines = spread.legs.map(l =>
        `  ${l.action === 'BUY' ? '📥 BUY ' : '📤 SELL'} ${l.strike} ${l.type} @ ₹${l.premium}`
    ).join('\n');

    const creditOrDebit = spread.netCredit !== undefined
        ? `💰 Net Credit : ₹${spread.netCredit} per unit`
        : `💸 Net Debit  : ₹${spread.netDebit} per unit`;

    const profitLine = spread.maxProfit !== undefined && typeof spread.maxProfit === 'number'
        ? `✅ Max Profit : ₹${spread.maxProfit} per unit (₹${Math.round(spread.maxProfit * 65)}/lot)`  // FIX: was ×75 (stale pre-Jan-2026 lot size)
        : `✅ Max Profit : ${spread.maxProfit}`;

    const lossLine = typeof spread.maxLoss === 'number'
        ? `🛑 Max Loss   : ₹${spread.maxLoss} per unit (₹${Math.round(spread.maxLoss * 65)}/lot)`  // FIX: was ×75
        : `🛑 Max Loss   : ${spread.maxLoss}`;

    const beLine = spread.breakEvenUp
        ? `↕️ Breakeven  : ${spread.breakEvenDn ? spread.breakEvenDn.toFixed(0) + ' – ' : ''}${spread.breakEvenUp.toFixed(0)}`
        : '';

    const msg = `
📊 <b>${spread.label}</b>
━━━━━━━━━━━━━━━━━━
📌 NIFTY: ${state.nifty?.toLocaleString('en-IN', {minimumFractionDigits: 2}) || '--'}
⚡ VIX: ${state.vix || '--'} | ADX: ${state.adx?.toFixed(1) || '--'} | DTE: ${spread.dte}d

<b>Legs:</b>
${legLines}

━━━━━━━━━━━━━━━━━━
${creditOrDebit}
${profitLine}
${lossLine}
${beLine ? beLine + '\n' : ''}🎯 Profit Zone: ${spread.profitZone}

💡 ${spread.reason}
📝 ${spread.note}
━━━━━━━━━━━━━━━━━━
⏰ ${new Date().toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' })}
<i>VardaanNifty AI — Spread Strategy</i>
`.trim();

    await sendMessage(msg);
}

// ── Exit warning for a still-open, auto-tracked signal (Signal Performance) ─
// Different from sendExitAlert (which is for the manual trade-journal position
// system with peak/trailSL tracking). This is a lightweight, ONE-TIME nudge:
// the ORIGINAL reasons for the trade (Delta, RSI) have weakened since entry,
// even though price hasn't hit SL or target yet. Purely a "conviction is
// fading, use your own judgement" signal — never auto-closes or resizes
// anything.
async function sendMomentumExitWarning(rec, currentDelta, currentRSI) {
    const dirLabel = rec.signal === 'BUY CALL' ? 'CALL' : 'PUT';
    const msg = `
⚠️ <b>EXIT WARNING — Setup Weakening</b>
━━━━━━━━━━━━━━━━━━
Your ${dirLabel} lead (${rec.strike}${rec.type}, entry ₹${rec.entry}) is still open, but the original conviction has faded:

Delta: ${rec.entryDelta}% → ${currentDelta}%
RSI: ${rec.entryRSI} → ${currentRSI}

Price hasn't hit SL or target — this isn't an auto-exit. Just a heads-up to reassess: book partial, tighten SL, or hold with awareness.
━━━━━━━━━━━━━━━━━━
`.trim();
    await sendMessage(msg);
}

module.exports = {
    sendSignalAlert,
    sendMTFAlert,
    sendScalpAlert,
    sendMorningSummary,
    sendVIXAlert,
    sendCloseSummary,
    sendExitAlert,
    sendMomentumExitWarning,
    sendNishanebaazAlert,
    sendSpreadAlert,
    sendRawMessage,
    isConfigured
};