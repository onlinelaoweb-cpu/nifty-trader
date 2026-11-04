'use strict';
// thresholds.js — ONE place for the VIX and PCR cut-offs (5 Nov 2026).
// Before this, the same VIX / PCR value could be "calm" on one card, "elevated" on another and "bullish" in a third, because each
// file carried its own numbers (VIX 14 / 15 / 18 / 20, PCR 0.7 / 0.75 / 0.8 / 0.9 / 1.1 / 1.2 / 1.3). Everything that is not a named
// strategy's own rule now reads these. Change a number here and the labels, gates, scores and size tiers all move together.
//
// VIX  <12 very low · 12–15 low (normal) · 15–20 ELEVATED (size cap 50%) · 20–30 HIGH (size cap 25%) · >=30 EXTREME
// PCR  >1.3 strong bull · >1.0 lean bull · 0.8–1.0 neutral · <0.8 lean bear · <0.6 strong bear   (pcrLabel: BULLISH >1.3, BEARISH <0.8)
//
// NOT covered on purpose: the Murarka zone (1.15 / 0.75, 1.10 / 0.80 on expiry day) — those are the named strategy's own rules.
const VIX_T = Object.freeze({ VERY_LOW: 12, ELEVATED: 15, HIGH: 20, EXTREME: 30 });
const PCR_T = Object.freeze({ STRONG_BULL: 1.3, LEAN_BULL: 1.0, LEAN_BEAR: 0.8, STRONG_BEAR: 0.6 });
module.exports = { VIX_T, PCR_T };