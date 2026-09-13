# 🪔 Vardaan AI — Project Summary

*in loving memory of Asha*

## Project Structure

```
nifty-trader/
├── server.js                    # Express backend — signal engine, all API routes, DB
├── public/
│   ├── index.html                # Entire frontend (single file, 13 tabs, no build step)
│   ├── manifest.json              # PWA manifest
│   └── sw.js                      # Service worker (network-first, no stale-shell)
├── src/api/                     # Backend modules
│   ├── angelAuth.js               # Angel One TOTP login
│   ├── websocket.js                # Angel WS tick handler (NIFTY + CRUDEOIL)
│   ├── nseData.js                  # PCR/option-chain: Fyers primary, NSE fallback
│   ├── indicators.js               # 1m candle history, momentum breakdown, POC, delta
│   ├── multiTimeframe.js           # 5m/15m/1h MTF alignment (with lag-detection)
│   ├── levels.js                   # S/R levels (pivots, prior highs/lows, max pain)
│   ├── dynamicLevels.js            # ATR-based H1-H3/L1-L3 bands
│   ├── physicsOfTrading.js         # 3-law framework + BOS/CHOCH detection
│   ├── breadth.js                  # Advance/decline market breadth
│   ├── globalCues.js               # SGX/Dow/global market sentiment
│   ├── historicalData.js           # Candle backfill
│   ├── optionGreeks.js             # Greeks calculation
│   ├── renko.js                    # Renko chart + ATR
│   ├── spreadStrategy.js           # Spread strategy builder
│   ├── volumeScanner.js            # 210 F&O stocks, 20-day volume baselines
│   ├── yahooFetch.js               # Yahoo Finance fallback source
│   └── telegram.js                 # All Telegram alert templates
├── package.json
├── Procfile                      # Railway start command
├── .env.example                  # Full environment variable template
└── README.md / QUICKSTART.md / SETUP.md
```

## What's Actually Built

This started as a basic NIFTY dashboard and grew, iteratively, into a two-asset (NIFTY + CRUDEOIL) signal system with its own analytics/journal/psychology tooling. The short version:

| Area | What's there |
|---|---|
| **Signal engine** | Dozens of weighted factors (RSI, EMA, VWAP, ADX/DI, MTF, Delta, OI, FII/DII, PCR, Early Momentum, News Sentiment, BOS/CHOCH...) combined with independently-toggleable quality gates |
| **Second asset** | Full CRUDEOIL pipeline, isolated from NIFTY's, own WS session-switching |
| **Broker data** | Angel One (primary WS), Fyers (primary PCR/option-chain), NSE direct + Yahoo (fallbacks) |
| **Alerts** | Telegram — a dozen+ distinct alert types, each independently gated/cooldown'd |
| **Persistence** | PostgreSQL, 15 tables — signal history, performance analytics, journal, gate-block stats, every exploratory feature |
| **Analytics** | Win rate / expectancy / profit factor / regime breakdown / setup-DNA leaderboard, weekly self-review, live best-setup status |
| **Discipline tooling** | GUARD (checklist + loss-lock + cooldown), with real Journal P&L synced in read-only |
| **Exploratory (untrusted-until-proven)** | Fast Momentum Trigger, S/R Bounce Trigger, Murarka Entry logging, Strike-Selection A/B Test, Combined PCR — each logs its own track record before being trusted for anything live |
| **Frontend** | Installable PWA, 13 tabs in 4 groups, day/night theme, live-tick chart animation |

## Design Principles This Codebase Actually Follows

1. **Isolation over convenience** — CRUDEOIL and NIFTY pipelines never touch each other's state, even though it would be less code to share it. A bug in one must never leak into the other.
2. **Log before you trust** — every new idea (a trigger, a strike-selection rule, a combined indicator) gets its own table and its own "exploratory" label before it's allowed to influence a real signal.
3. **Graceful degradation** — nearly every external data fetch has a fallback chain (Angel → Fyers → NSE → Yahoo, roughly), so one broker/API being down degrades the app rather than crashing it.
4. **Data over opinion** — thresholds and rules get revisited when the data says so (see: the Breakout-regime confidence cap, the Trend-Conviction gate, the 15m-lag MTF fix), not just when they "feel" wrong.

## Not Included (By Design)

- **No automated order placement.** Everything here generates signals and sends alerts; every trade is placed manually by the user.
- **No guaranteed accuracy.** Signal quality is tracked transparently (see Analytics tab) rather than assumed.

## Environment Variables

Full list with descriptions in `.env.example`. Angel One is the minimum for live price data; Fyers/Telegram/Postgres each unlock a major feature area (option-chain data, alerts, and all persistence respectively) and are optional but strongly recommended.