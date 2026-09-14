// ── Timing / session-window helpers ──────────────────────────────────────
// Extracted verbatim from server.js (13 Sep refactor, Phase 1).
// All functions here are pure — they read only the system clock and
// isNSEHoliday(), never marketState. Safe to unit-test in isolation.
const { isNSEHoliday, isMCXEveningHoliday } = require('../api/nseData');

function getIST() { return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'})); }

function isMarketOpen() {
    const ist = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}));
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;  // weekend
    if (isNSEHoliday(ist)) return false;       // NSE holiday — sourced from nseData.js
    const m = ist.getHours()*60 + ist.getMinutes();
    return m >= 555 && m <= 930;
}

function isSafeEntryWindow() {
    const ist = getIST();
    const m   = ist.getHours()*60 + ist.getMinutes();
    if (m < 555) return { status:'pre',      label:'Pre-Open',                   safe:false, reason:'Market not open yet' };
    if (m < 600) return { status:'volatile', label:'Volatile (9:15–10:00)',        safe:false, reason:'Gap-fill window — wait for 10:00 (Murarka strategy)' };
    if (m < 840) return { status:'trade',    label:'Safe Entry (10:00–14:00)',      safe:true,  reason:null };
    if (m < 870) return { status:'caution',  label:'⚠️ Caution Zone (14:00–14:30)',safe:true,  reason:'Reduce position size — theta decay starting' };
    if (m <= 930) return { status:'theta',   label:'Theta Zone (14:30–15:30)',     safe:false, reason:'Theta decay accelerating — avoid new entries' };
    return              { status:'closed',   label:'Market Closed',               safe:false, reason:'Market closed' };
}

function isNSEMarketDay() {
    const ist = getIST();
    const day = ist.getDay();          // 0=Sun, 1=Mon ... 5=Fri, 6=Sat
    const m   = ist.getHours()*60 + ist.getMinutes();
    if (day === 0 || day === 6) return false;   // Weekend
    if (isNSEHoliday(ist))     return false;   // NSE holiday
    return m >= 540 && m <= 935;                // 9:00 AM to 15:35 IST only
}

// ── Phase 2 additions (13 Sep) — extracted verbatim from server.js ───────

function daysToNextExpiry() {
    const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = ist.getDay();   // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
    // Days until next Tuesday
    let daysUntilTue = (2 - day + 7) % 7;
    if (daysUntilTue === 0) {
        // Today IS Tuesday — check if market already closed (after 15:30)
        const minNow = ist.getHours() * 60 + ist.getMinutes();
        if (minNow >= 930) daysUntilTue = 7;  // next Tuesday
    }
    // Walk the target expiry date back a day at a time while it's an NSE
    // holiday, so DTE reflects the real (shifted) expiry, not the nominal Tuesday.
    let expiryDate = new Date(ist);
    expiryDate.setDate(expiryDate.getDate() + daysUntilTue);
    let daysBack = 0;
    while (isNSEHoliday(expiryDate) && daysBack < 6) {
        expiryDate.setDate(expiryDate.getDate() - 1);
        daysUntilTue -= 1;
        daysBack++;
    }
    // Remaining minutes today until 15:30
    const minsUntilClose = Math.max(0, 930 - (ist.getHours() * 60 + ist.getMinutes()));
    const fracToday = minsUntilClose / (24 * 60);
    const total = daysUntilTue + fracToday;
    return Math.max(0.04, total);  // minimum 1hr equivalent
}

function isCrudeSessionOpen() {
    const ist = getIST();
    const day = ist.getDay();
    if (day === 0 || day === 6) return false;         // Weekend
    if (isMCXEveningHoliday(ist)) return false;        // MCX evening-session holiday
    const m = ist.getHours()*60 + ist.getMinutes();
    return m >= 1050 && m <= 1435;                     // 5:30 PM – 11:55 PM IST
}

function getActiveSession() {
    if (isNSEMarketDay())   return 'NIFTY';
    if (isCrudeSessionOpen()) return 'CRUDEOIL';
    return 'CLOSED';
}

module.exports = {
    getIST, isMarketOpen, isSafeEntryWindow, isNSEMarketDay,
    daysToNextExpiry, isCrudeSessionOpen, getActiveSession,
};
