# Forward test #2 — Nifty 1H trend rule (pre-registered 25 Nov 2026)

Written BEFORE any result, so the rule and pass conditions cannot be changed after looking.

## Why
Forward test #1 (scalp, HOLD+SL15 60 min, 26 Oct–23 Nov) FAILED: 902 trades / 20 days, net -Rs 1,08,698, PF 0.92, both halves negative.
That rule stays closed. Its recorder keeps running (record-only), no new decisions are taken from it.

## Rule under test (Trend Shadow, already logging; do not edit)
- Instrument: Nifty 50 index, 1-hour bars (Angel getCandleData).
- LONG when close > SMA50 and Supertrend(ATR10, x3) is up; SHORT when close < SMA50 and Supertrend is down.
- Exit on Supertrend flip. No stop, no target, no option leg: the test is on the index points only.
- Log: `[TrendShadow]` / `/api/trend-shadow`. Forward start: first signal after 25 Nov 2026 (earlier trades are backfill, not forward).

## Pass conditions (all must hold)
1. At least 30 closed forward trades. At 1-3 trades per month this takes a long time, so expect a 6-12 month test. Do not judge earlier.
2. Net points after costs (about 3 pts per round trip on index/futures proxy) > 0.
3. Profit factor >= 1.3.
4. Best single trade <= 25% of total profit.
5. Older half and newer half both > 0.

## Not allowed
- Changing the periods, multiplier or exit after seeing results.
- Treating a pass as permission to trade live: paper-trade it next.
- Judging on fewer than 30 trades.
