# ⚡ Quick Start Guide (5 Minutes)

## Step 1: Prepare Your Credentials

At minimum, you need Angel One (for live price data). Everything else is optional but unlocks major features — see the table below.

```
ANGEL_API_KEY = [from Angel One dashboard]
ANGEL_CLIENT_ID = [your account ID]
ANGEL_PASSWORD = [your login PIN]
ANGEL_TOTP_SECRET = [TOTP secret from Angel One's API section — needed for auto-login]
```

⚠️ **DON'T SHARE THESE** — keep them private, and only ever paste them into Railway's Variables panel, never into code or GitHub.

| Variable(s) | Unlocks | Required? |
|---|---|---|
| `ANGEL_API_KEY`, `ANGEL_CLIENT_ID`, `ANGEL_PASSWORD`, `ANGEL_TOTP_SECRET` | Live price/tick data (NIFTY + CRUDEOIL) | **Yes** |
| `DATABASE_URL` | Journal, Analytics, all signal/performance history — without this, nothing persists | Strongly recommended |
| `FYERS_APP_ID`, `FYERS_SECRET_ID`, `FYERS_ACCESS_TOKEN`, `FYERS_REFRESH_TOKEN`, `FYERS_PIN` | PCR / option-chain data (primary source), Combined PCR, crude PCR | Strongly recommended |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | All Telegram alerts | Recommended |
| `ANTHROPIC_API_KEY` | News Sentiment scoring | Optional |
| `APP_TOKEN` | Locks down API endpoints with a shared secret | Optional (recommended if the URL is ever shared) |
| `NEWSAPI_KEY`, `FINNHUB_API_KEY`, `SCRAPERAPI_KEY` | Secondary/fallback data sources | Optional |

Full descriptions of every variable are in `.env.example`.

---

## Step 2: Create GitHub Repository

```bash
# Clone this project
git clone https://github.com/YOUR_USERNAME/nifty-trader.git
cd nifty-trader

# Or if starting fresh:
git init
git add .
git commit -m "Vardaan AI"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/nifty-trader.git
git push -u origin main
```

---

## Step 3: Deploy on Railway (Click-Click!)

1. **Go to**: https://railway.app (sign up free)
2. **Dashboard** → **Create Project** → **Deploy from GitHub**
3. **Connect GitHub** → select `nifty-trader`
4. **Add a PostgreSQL database** to the same project (Railway: "+ New" → "Database" → "PostgreSQL") — `DATABASE_URL` gets wired in automatically
5. Railway starts deploying automatically ✅

**Wait 1-2 minutes for deployment...**

---

## Step 4: Add Your Credentials

1. Go to your Railway project → the **web** service → **Variables** tab
2. Add the variables from the table above (at minimum, the 4 Angel One ones)
3. **Save** → Railway auto-redeploys ✅

---

## Step 5: Open Your Dashboard

Railway gives you a URL like:
```
https://web-production-xxxxx.up.railway.app
```

**Click the link → Done!** 🎉

---

## 📱 Access From Phone

1. Open the Railway URL in your phone's browser
2. You'll be prompted to **Install as app** (PWA) — do this for a proper app-like experience with a home-screen icon
3. Live data streams via SSE — no manual refresh needed
4. Get Telegram alerts on your phone for anything the dashboard flags

---

## 🔄 Updates & Changes

```bash
git add .
git commit -m "Your changes"
git push origin main
```

Railway **auto-deploys** on push (1-2 min).

---

## ✅ You're Done!

Your dashboard is now:
- ✅ Running 24/7 on the cloud
- ✅ Streaming live NIFTY + CRUDEOIL data
- ✅ Running the full signal engine with quality gates
- ✅ Logging everything to Postgres for the Analytics/Journal tabs
- ✅ Sending Telegram alerts (if configured)

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Angel One Auth Failed" | Double-check all 4 Angel variables, especially `ANGEL_TOTP_SECRET` — a wrong TOTP secret fails login silently |
| Dashboard shows stale/no price | Check Railway logs (Deployments → Logs) — confirms whether it's actively falling back to Yahoo |
| No PCR / option-chain data | `FYERS_*` variables missing or expired — Fyers access tokens need periodic refresh |
| No Telegram alerts | Check `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, and use the in-app "Test Telegram" button |
| Analytics/Journal empty | `DATABASE_URL` not set, or Postgres not attached to the project |

For more detail → see `README.md` and `SETUP.md`.