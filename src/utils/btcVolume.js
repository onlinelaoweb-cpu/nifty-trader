'use strict';
// Bitcoin volume ratio from per-candle volume.
// Why: Delta's ticker `volume` is a rolling 24h total, so "latest vs average of
// recent polls" was always ~1.00x and every break was tagged WEAK. Here we compare
// the last COMPLETED candle's own volume with the average of the candles before it.
function volumeRatioFromCandles(candles, nowSec, periodSec, lookback = 20) {
    if (!Array.isArray(candles) || !periodSec) return null;
    const done = candles.filter(c => Number.isFinite(c.volume) && (nowSec == null || c.time + periodSec <= nowSec));
    if (done.length < 6) return null;
    const last = done[done.length - 1];
    const prev = done.slice(-1 - lookback, -1);
    if (prev.length < 5 || last.volume <= 0) return null;
    const avg = prev.reduce((s, c) => s + c.volume, 0) / prev.length;
    if (!(avg > 0)) return null;
    return { volume: last.volume, avgVolume: avg, ratio: last.volume / avg, candleTime: last.time };
}
module.exports = { volumeRatioFromCandles };