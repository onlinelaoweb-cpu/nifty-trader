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

// 2 Oct — refined again, per the user's own follow-up: instead of fully
// always-on (previous version, kept below as dead code), explicitly keep
// NIFTY's own hours Bitcoin-free ("nifty independent rehne do") — active
// Mon-Fri 16:00 (4PM) through 08:50 next morning (crossing midnight,
// comfortably covering Crude's own evening session AND the 21:30-22:15 IST
// move that started this whole change), full-time Sat/Sun, OFF during
// 08:50-16:00 on weekdays — which covers NIFTY's 9:15-15:30 session with a
// buffer on both sides.
function isBitcoinWindowOpen() {
    const ist = getIST();
    const day = ist.getDay(); // 0=Sun..6=Sat
    if (day === 0 || day === 6) return true;           // Full-time Sat & Sun
    const m = ist.getHours()*60 + ist.getMinutes();
    if (m >= 960) return true;                          // 16:00 (4PM) onwards tonight
    if (m <= 530) {                                      // up to 08:50 this morning —
        const yesterday = (day + 6) % 7;                 // tail of LAST NIGHT's window,
        // same Monday-morning-gap handling as the original 25 Sep fix:
        // yesterday===6 (Saturday) can't actually reach here since Sunday
        // is already caught by the day===0 check above — so this is simply
        // "yesterday was any day except Saturday".
        return yesterday <= 5;
    }
    return false;                                        // 08:50-16:00 weekdays — NIFTY's own hours, left alone
}

// Previous "always-on" version (2 Oct, same day) — superseded by the above
// per the user's immediate follow-up ask to keep NIFTY's hours separate.
// Kept as dead code, not deleted, for the same reason as the version below
// it: easy revert if ever needed.
function _isBitcoinWindowOpen_ALWAYS_ON_2Oct() {
    return true;
}

// Original Mon-Fri 23:59-08:55 + full-weekend window logic, preserved
// below (unreachable, dead code) in case this ever needs reverting —
// deliberately NOT deleted, given how much back-and-forth tuning went into
// it (including the 25 Sep Monday-morning-gap fix noted in its own comment).
function _isBitcoinWindowOpen_ORIGINAL_25Sep() {
    const ist = getIST();
    const day = ist.getDay(); // 0=Sun..6=Sat
    if (day === 0 || day === 6) return true;           // Full-time Sat & Sun
    const m = ist.getHours()*60 + ist.getMinutes();
    if (m >= 1439) return true;                        // 23:59 onwards tonight
    if (m <= 535) {                                     // up to 08:55 this morning —
        const yesterday = (day + 6) % 7;                // tail of LAST NIGHT's window,
        // 25 Sep — FIX: was "yesterday >= 1" (Mon-Fri only), which left
        // Monday 00:00-08:55 uncovered (tail of Sunday night — Sunday
        // wasn't in that range). Sunday's own "full-time" already covers
        // Sunday itself; this just lets that tail bleed into Monday
        // morning too, per the user's explicit ask. yesterday===6
        // (Saturday) can't actually reach here since Sunday is already
        // caught by the day===0 check above — so this is simply
        // "yesterday was any day except Saturday".
        return yesterday <= 5;
    }
    return false;
}

function getActiveSession() {
    if (isNSEMarketDay())   return 'NIFTY';
    if (isCrudeSessionOpen()) return 'CRUDEOIL';
    if (isBitcoinWindowOpen()) return 'BITCOIN';
    return 'CLOSED';
}

module.exports = {
    getIST, isMarketOpen, isSafeEntryWindow, isNSEMarketDay,
    daysToNextExpiry, isCrudeSessionOpen, isBitcoinWindowOpen, getActiveSession,
};