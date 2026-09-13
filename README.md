# 🪔 Vardaan AI

**in loving memory of Asha**

A real-time, multi-asset options trading dashboard covering **NIFTY** and **CRUDEOIL**, with a rule-based signal engine, live broker data (Angel One + Fyers), Telegram alerts, and a Postgres-backed analytics/journal system. Built and refined iteratively — most of the logic exists because a real trade or a real data pull showed a gap, not because it looked good on paper.

---

## What This Actually Is

Not a toy demo — this runs live, trades real capital decisions, and every major rule in `combineSignals()` has a comment explaining what real-world observation led to it. It is also **not fully automated**: it generates signals and sends alerts, but the user places every trade manually. Two newer experimental pieces (Strike-Selection A/B Test, Combined PCR) exist specifically to test ideas against real data before anything is trusted.

---

## Core Feature Set

### NIFTY Engine
- **Main signal engine** (`combineSignals()`) — dozens of weighted factors: RSI, EMA9/21 cross, VWAP, ADX/DI (VIX-adjusted floor), Multi-Timeframe alignment (5m/15m/1h, with lag-detection for both 1h and 15m), Delta (order-flow), OI Buildup, FII/DII flow, PCR extremes, ATM CE/PE premium ratio, Early Momentum (7-vote leading indicator), Candle Pattern detection, BOS/CHOCH (break of structure), News Sentiment (via Claude), Trend Conviction, and more.
- **Quality gates** — RSI-clean, ADX-trend, MTF-aligned, S/R-wall clearance, POC clearance, sequence-check, safe-entry-window. Each gate is independently toggleable and logged.
- **Physics of Trading** — a 3-law framework (candle/force/swing) with its own confidence scoring, tracked separately from the main engine.
- **Smart Money Bias** — 4-factor institutional-positioning read (OI Buildup + FII/DII + PCR + ATM premium ratio), −8 to +8 score.
- **Momentum Detector** — 5-layer breakout/breakdown detector (velocity, candle body, volume surge, acceleration, 5m-slope confirmation).
- **Murarka Strategy** — PCR-zone + VWAP-proximity combined entry (CA Nitin Murarka's methodology), with its own dashboard panel and Telegram alert.
- **Dynamic Levels** — ATR-based H1–H3/L1–L3 bands plus classic pivots, prior-day/week/month highs-lows, and max pain.
- **Volume Scanner** — 210 F&O stocks, 20-day volume baselines, live RVOL.

### CRUDEOIL Engine (Phase 1–5)
Independent signal pipeline for the MCX crude session (5:30 PM–11:55 PM IST): its own WS session-switching, 3-minute candle basis, PCR gate via Fyers option chain, and full signal logging — deliberately isolated from the NIFTY pipeline so a bug in one can never leak into the other.

### Exploratory / Not-Yet-Trusted Features
These log to their own tables and send clearly-labeled Telegram alerts, but do **not** gate or feed the main engine, precisely because they haven't earned that trust yet:
- **Fast Momentum Trigger** — raw price-velocity, ATR-adjusted threshold, no MTF requirement (built to catch fast moves the main engine's confirmation lag misses).
- **S/R Bounce Trigger** — price tests a known S/R level, pulls back with RSI confirmation.
- **Murarka Entry logging** — the PCR+VWAP signal above, now with a persistent track record.
- **Strike-Selection A/B Test** — runs our own VIX-based strike logic side-by-side against an alternative rule from a trading-education source, on real signals, to see which actually performs better.
- **Combined PCR** — Nifty + BankNifty + Sensex + top-10-heavyweight-stocks PCR blended into one sentiment reading (equal-weighted by default — no externally-agreed "best" weighting exists, so this is tuned from our own data over time).

### Data & Analytics
- **PostgreSQL-backed logging** — 15 tables covering signal history, performance tracking (win rate, expectancy, profit factor, regime breakdown, setup-DNA leaderboard), daily gate-block stats, journal trades, and every exploratory feature above.
- **Journal** — manual + auto-logged (from Telegram alerts) trade tracking with P&L.
- **Analytics tab** — 30/180-day performance analytics, weekly self-review (which gates block the most and whether that's a problem), best-historical-setup live status.
- **GUARD** — a discipline tool (pre-trade checklist, daily-loss-lock, revenge-trade cooldown) with a read-only live sync of the day's actual Journal P&L alongside the manual-entry flow.

### Data Sources & Resilience
- **Angel One SmartAPI** — primary WebSocket tick feed (NIFTY + CRUDEOIL), TOTP-based auth.
- **Fyers** — primary PCR/option-chain source (`options-chain-v3`), also used for BankNifty/Sensex/stock PCR and quote data.
- **NSE direct** — fallback option-chain source with URL rotation and cookie refresh.
- **Yahoo Finance** — fallback price/candle source when NSE/Angel are unavailable (with an explicit "volume is fake on Yahoo" guard so momentum detection doesn't misfire on it).
- Nearly every external fetch has a documented fallback chain — the app is built to degrade gracefully, not crash, when any one data source is down.

### Frontend
Single-page, mobile-first PWA (installable). 13 tabs grouped into 4 sections (Main / Crude Oil / Market Data / Tools & Analysis). Day/night theme. Live-tick chart animation (candle tracks price between periodic re-fetches). Splash + login screens carry a dedication to **Asha**.

---

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Broker APIs**: Angel One SmartAPI (WebSocket + REST), Fyers (REST)
- **Alerts**: Telegram Bot API
- **AI**: Anthropic Claude API (News Sentiment scoring)
- **Frontend**: Vanilla JS, single HTML file, no build step
- **Hosting**: Railway

---

## Environment Variables

See `.env.example` for the full, current list with descriptions. At minimum you need Angel One credentials for live price data; Fyers, Telegram, and Postgres are each optional but unlock major features (PCR/option-chain data, alerts, and all persistence/analytics respectively).

---

## Running Locally

```bash
npm install
cp .env.example .env   # fill in your real credentials
npm start
```

Opens on `http://localhost:3000` (or `$PORT` if set).

---

## Deploying

See `QUICKSTART.md` for a 5-minute Railway deploy, or `SETUP.md` for the full environment-variable walkthrough.

---

## ⚠️ Trading Disclaimer

This is a signal-generation and analytics tool, not financial advice, and it does not place trades automatically. Every signal — including the exploratory ones — can be wrong. Past performance shown in the Analytics tab does not guarantee future results. Trade with capital you can afford to lose, and use your own judgment alongside what this app shows you.