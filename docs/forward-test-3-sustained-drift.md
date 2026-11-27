# Forward test #3 — Sustained Drift + trailing exit (pre-registered 27 Nov 2026)

Written BEFORE any result. Do not change the rule or the pass conditions after looking.

## Why
Forward test #1 (all triggers, HOLD+SL15) FAILED: 902 trades / 20 days, net -Rs 1,08,698, PF 0.92, both halves negative.
The 60-day studies (scalp-cost, exit-rule, hour-of-day) found only two small leads:
- Trigger **Sustained Drift**: the only trigger positive after costs (HOLD +Rs 161/trade, n=159).
- Exit **BOOK20_TRAIL12**: beat the live Trade-Coach grid in both halves (+0.5% of premium on average).
Both came from looking at ~12 triggers x ~9 exits, so they can be luck. This test checks exactly that ONE combination on signals fired AFTER today.

## Rule (fixed)
- Signals: NIFTY, source = "Sustained Drift" only, fired on or after **Mon 30 Nov 2026**. Declustered 30 min. Entry premium >= 10.
- Exit (percent of entry premium): hard stop -15%; book half at +20% and lock breakeven; trail the rest 12 points below its peak; otherwise out when the stored premium path ends (~90 min).
- Costs: 0.5 pt slippage each side + 0.07% charges each side + Rs 0 brokerage, qty 65 (1 lot).
- Only signals whose 90-minute path has fully passed are counted.

## Pass conditions (all must hold)
1. At least 150 trades over at least 30 trading days.
2. Net average after costs > 0.
3. Older half AND newer half both > 0.
4. Profit factor >= 1.2.
5. Best single trade <= 15% of total profit.

## How to read it
`/api/drift-forward-test?format=text&key=PASSKEY` (read-only; replays premium paths the app already stores; touches no signal, gate, alert or display).
STATUS stays COLLECTING until 150 trades and 30 days are in (about 6-8 weeks at ~4 signals a day).

## Not allowed
- Changing the trigger, exit numbers, costs or criteria after seeing results.
- Adding a time-of-day filter or a second trigger part-way.
- Treating a pass as permission to trade live: paper-trade it next (Paper Trade card, Tools tab).
