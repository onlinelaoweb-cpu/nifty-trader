'use strict';
// ── Order Ticket — DRY RUN ONLY (17 Oct 2026) ────────────────────────────────────────────────────────────────────────────
// Builds and checks a manual NIFTY option BUY ticket (entry + stop loss + up to 3 scale-out targets with their own lots + trailing rule + time stop)
// and shows exactly what WOULD be sent to a broker.
// It NEVER sends anything: there is no broker client in this file and LIVE_ORDERING_ENABLED is a hard false. Tickets are only logged
// (table manual_orders) so the form, the numbers and the safety checks can be tried before any live ordering is ever built.
// Separate from the paper-trade journal on purpose. Not advice; levels are whatever the user types.

const LIVE_ORDERING_ENABLED = false;
const TICK = 0.05, MAX_LOTS = 10, STRIKE_STEP = 50;

const roundTick = x => Math.round(x / TICK) * TICK;
const r2 = x => Math.round(x * 100) / 100;
const num = v => (v === '' || v == null ? NaN : Number(v));

// input: { optionType:'CE'|'PE', strike, expiry?, lots?, orderType:'MARKET'|'LIMIT', entryPrice, slPrice | slPct,
//          targetPrice | targetPct            (single target = all lots)   OR
//          targets: [{ price | pct, lots }]   (1-3 scale-out targets; the lots must add up to the total lots; total lots may be left blank = their sum)
//          trailMode?: 'NONE'|'STEP'|'POINTS', trailPoints?, timeStop?: 'HH:MM' (IST) }
// entryPrice is required for MARKET too (the premium you expect to get filled at) - SL / targets / risk are measured from it.
function buildTicket(input, { lotSize = 65, maxLots = MAX_LOTS } = {}) {
    const errors = [], warnings = [];
    const fail = () => ({ ok: false, errors, warnings, liveOrderingEnabled: LIVE_ORDERING_ENABLED });
    const i = input || {};
    const optionType = String(i.optionType || '').toUpperCase();
    if (optionType !== 'CE' && optionType !== 'PE') errors.push('optionType CE ya PE hona chahiye');
    const strike = num(i.strike);
    if (!(strike > 0) || strike % STRIKE_STEP !== 0) errors.push(`strike ${STRIKE_STEP} ka multiple hona chahiye`);
    const orderType = String(i.orderType || 'LIMIT').toUpperCase();
    if (orderType !== 'MARKET' && orderType !== 'LIMIT') errors.push('orderType MARKET ya LIMIT');
    const entry = num(i.entryPrice);
    if (!(entry > 0)) errors.push('entryPrice (premium) daalo');
    let expiry = null;
    if (i.expiry != null && String(i.expiry).trim() !== '') {
        expiry = String(i.expiry).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || isNaN(Date.parse(expiry))) errors.push('expiry YYYY-MM-DD format mein ho');
    }
    // trailing + time stop (validated early so every error is reported together)
    const trailMode = String(i.trailMode || 'NONE').toUpperCase();
    if (!['NONE', 'STEP', 'POINTS'].includes(trailMode)) errors.push('trailMode NONE, STEP ya POINTS');
    const trailPoints = num(i.trailPoints);
    if (trailMode === 'POINTS' && !(trailPoints > 0)) errors.push('POINTS trailing ke liye trailPoints (premium points) daalo');
    let timeStop = null;
    if (i.timeStop != null && String(i.timeStop).trim() !== '') {
        timeStop = String(i.timeStop).trim();
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeStop)) errors.push('timeStop HH:MM (IST, 24 ghante) format mein ho');
    }
    // target rows: explicit list, or the single legacy target (all lots)
    const rawTargets = Array.isArray(i.targets) ? i.targets.filter(t => t && !((t.price === '' || t.price == null) && (t.pct === '' || t.pct == null) && (t.lots === '' || t.lots == null))) : null;
    if (rawTargets && rawTargets.length > 3) errors.push('targets 3 se zyada nahi');
    if (rawTargets && rawTargets.length === 0) errors.push('kam se kam 1 target daalo');
    let lots = num(i.lots);
    const tLots = rawTargets && rawTargets.length ? rawTargets.map(t => num(t.lots)) : [];
    if (rawTargets && rawTargets.length && (lots !== lots || i.lots === '' || i.lots == null)) {            // total lots blank -> sum of the target lots
        if (tLots.every(x => Number.isInteger(x) && x >= 1)) lots = tLots.reduce((a, b) => a + b, 0);
    }
    if (!Number.isInteger(lots) || lots < 1) errors.push('lots poora number (1 ya zyada) hona chahiye');
    else if (lots > maxLots) errors.push(`lots ${maxLots} se zyada nahi (safety cap)`);
    if (errors.length) return fail();

    const entryP = roundTick(entry);
    // stop loss: absolute price wins over percent
    let sl = num(i.slPrice); const slPct = num(i.slPct);
    if (!(sl > 0) && slPct > 0 && slPct < 100) sl = entryP * (1 - slPct / 100);
    if (!(sl > 0)) errors.push('SL daalo (price ya %)');
    const priceOf = t => { let p = num(t.price); const pc = num(t.pct); if (!(p > 0) && pc > 0) p = entryP * (1 + pc / 100); return p; };
    let targets;
    if (rawTargets) {
        targets = rawTargets.map((t, k) => ({ price: priceOf(t), lots: num(t.lots), n: k + 1 }));
        targets.forEach(t => {
            if (!(t.price > 0)) errors.push(`T${t.n}: target price ya % daalo`);
            if (!Number.isInteger(t.lots) || t.lots < 1) errors.push(`T${t.n}: lots poora number (1 ya zyada) daalo`);
        });
    } else {
        targets = [{ price: priceOf({ price: i.targetPrice, pct: i.targetPct }), lots, n: 1 }];
        if (!(targets[0].price > 0)) errors.push('Target daalo (price ya %)');
    }
    if (errors.length) return fail();
    sl = roundTick(sl); targets.forEach(t => { t.price = roundTick(t.price); });
    if (sl >= entryP) errors.push('SL entry se neeche hona chahiye (buy option)');
    if (sl < TICK) errors.push('SL bahut neeche (0.05 se kam)');
    targets.forEach((t, k) => {
        if (t.price <= entryP) errors.push(`T${t.n} entry se upar hona chahiye (buy option)`);
        if (k > 0 && t.price <= targets[k - 1].price) errors.push(`T${t.n} T${k} se upar hona chahiye`);
    });
    const sumLots = targets.reduce((a, t) => a + t.lots, 0);
    if (sumLots !== lots) errors.push(`targets ke lots ka jod ${sumLots} hai, total lots ${lots} hone chahiye`);
    if (errors.length) return fail();

    const qty = lots * lotSize;
    const riskPerUnit = entryP - sl;
    const slLimit = Math.max(TICK, roundTick(sl * 0.98));            // SL-Limit: limit a little below the trigger so it still fills in a fast fall
    const rewardTotal = targets.reduce((a, t) => a + t.lots * lotSize * (t.price - entryP), 0);   // all targets hit
    const rr = r2(rewardTotal / (qty * riskPerUnit));
    if (rr < 1) warnings.push(`Reward:Risk ${rr} (1 se kam) - targets SL se chhote hain`);
    if (sl / entryP < 0.5) warnings.push('SL premium ka aadha se zyada neeche hai - bahut bada nuksaan ho sakta hai');
    if (orderType === 'MARKET') warnings.push('MARKET order mein fill price entryPrice se alag ho sakta hai - SL/target/risk uske hisaab se badlenge');
    if (timeStop && timeStop > '15:20') warnings.push('timeStop 15:20 ke baad hai - broker us se pehle auto square-off kar sakta hai');
    if (trailMode === 'STEP' && targets.length < 2) warnings.push('STEP trailing mein T1 ke baad SL entry par aata hai; T2 ke baad T1 par - 1 target mein sirf pehla step lagega');

    // stop level that protects the REMAINING lots once k targets are done (never below the original SL)
    const stopAfter = k => {
        if (trailMode === 'STEP') return k >= 2 ? Math.max(sl, targets[k - 2].price) : Math.max(sl, entryP);
        if (trailMode === 'POINTS') return Math.max(sl, roundTick(targets[k - 1].price - trailPoints));
        return sl;
    };
    const scenarios = [{ name: 'SL pehle hi lage', lotsOut: lots, rs: Math.round(-riskPerUnit * qty) }];
    let booked = 0, bookedLots = 0;
    targets.forEach((t, k) => {
        booked += t.lots * lotSize * (t.price - entryP); bookedLots += t.lots;
        const left = lots - bookedLots;
        if (left > 0) {
            const st = stopAfter(k + 1);
            scenarios.push({ name: `T${t.n} tak, phir bachi ${left} lot stop par (${r2(st)})${trailMode === 'POINTS' ? ' [worst-case]' : ''}`, lotsOut: lots, rs: Math.round(booked + left * lotSize * (st - entryP)) });
        } else scenarios.push({ name: `Saare targets lage (T1-T${t.n})`, lotsOut: lots, rs: Math.round(booked) });
    });

    const ticket = {
        mode: 'DRY_RUN', sent: false,
        instrument: 'NIFTY', exchange: 'NFO', optionType, strike, expiry, side: 'BUY', product: 'INTRADAY', lots, lotSize, quantity: qty,
        entry: { orderType, price: orderType === 'LIMIT' ? r2(entryP) : 0, expectedPrice: r2(entryP) },
        stopLoss: { orderType: 'SL-LIMIT', trigger: r2(sl), limit: r2(slLimit), side: 'SELL' },
        target: { orderType: 'LIMIT', price: r2(targets[0].price), side: 'SELL' },                       // first target (kept for the single-target shape)
        targets: targets.map(t => ({ n: t.n, orderType: 'LIMIT', price: r2(t.price), lots: t.lots, quantity: t.lots * lotSize, side: 'SELL' })),
        trail: { mode: trailMode, points: trailMode === 'POINTS' ? trailPoints : null,
            rule: trailMode === 'STEP' ? 'T1 ke baad SL entry par, T2 ke baad SL T1 par' : trailMode === 'POINTS' ? `T1 ke baad SL = peak - ${trailPoints} points (sirf upar jaata hai)` : 'trailing nahi' },
        timeStop: timeStop ? { at: timeStop, rule: `${timeStop} IST tak koi SL/target na lage to bachi position market par band` } : null,
        scenarios,
        risk: { maxLossRs: Math.round(riskPerUnit * qty), targetProfitRs: Math.round(rewardTotal), riskPerUnit: r2(riskPerUnit), rewardPerUnit: r2(rewardTotal / qty), rr },
        managedByApp: targets.length > 1 || trailMode !== 'NONE' || !!timeStop,
        note: 'DRY RUN - Stoxkart ko kuch NAHI bheja gaya. Live ordering band hai.',
    };
    if (ticket.managedByApp) warnings.push('Ek se zyada target, trailing aur time stop exchange mein ek saath nahi rakhe jaate - live mein inhe app ko khud sambhalna padega (abhi sirf plan dikha rahe hain)');
    return { ok: true, errors: [], warnings, ticket, liveOrderingEnabled: LIVE_ORDERING_ENABLED };
}

module.exports = { LIVE_ORDERING_ENABLED, buildTicket, roundTick };
