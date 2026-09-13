# Setup: Environment Variables on Railway

## Step 1: Get Your Angel One Credentials (Required)

1. Log in to your [Angel One](https://www.angelone.in) account
2. Go to **Settings → API** and generate an API key
3. Enable **TOTP** for your account and note the TOTP secret (needed for automated login — the app logs in fresh each session using this)

You'll end up with 4 values: API Key, Client ID, Password (your login PIN), and TOTP Secret.

## Step 2: (Recommended) Get Fyers Credentials

Fyers is the primary source for PCR / option-chain data (NIFTY, CRUDEOIL, and — if using the Combined PCR feature — BankNifty/Sensex/individual stocks). Without it, the app falls back to scraping NSE directly, which is slower and less reliable.

Sign up at [fyers.in](https://fyers.in), create an API app, and generate: App ID, Secret ID, Access Token, Refresh Token, and PIN.

## Step 3: (Recommended) Set Up a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram, create a bot, get the bot token
2. Message your new bot once, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat ID

## Step 4: Add a PostgreSQL Database

In your Railway project: **"+ New" → "Database" → "Add PostgreSQL"**. Railway wires `DATABASE_URL` into your web service automatically — no manual copying needed. Without this, Journal/Analytics/all signal-performance tracking simply won't persist (the live dashboard still works, but nothing is remembered between restarts).

## Step 5: Add Environment Variables to Railway

1. Go to railway.app → your project → the **web** service → **Variables**
2. Click **"New Variable"** and add each of these:

```
ANGEL_API_KEY = [your API key]
ANGEL_CLIENT_ID = [your Client ID]
ANGEL_PASSWORD = [your login PIN]
ANGEL_TOTP_SECRET = [your TOTP secret]

FYERS_APP_ID = [your app ID]
FYERS_SECRET_ID = [your secret ID]
FYERS_ACCESS_TOKEN = [your access token]
FYERS_REFRESH_TOKEN = [your refresh token]
FYERS_PIN = [your Fyers PIN]

TELEGRAM_BOT_TOKEN = [your bot token]
TELEGRAM_CHAT_ID = [your chat ID]

ANTHROPIC_API_KEY = [optional — for News Sentiment scoring]
APP_TOKEN = [optional — a secret you choose, locks down API endpoints]
```

(`DATABASE_URL` is set automatically once Postgres is attached — don't add it manually.)

3. **Never share these credentials, and never commit them to GitHub.** Railway's Variables panel is the only place they should live.
4. Click **Save** — Railway auto-redeploys with the new variables.

## Optional Extras

| Variable | Purpose |
|---|---|
| `NEWSAPI_KEY` | Alternate news source |
| `FINNHUB_API_KEY` | Alternate market-data fallback |
| `SCRAPERAPI_KEY` | Proxy for NSE scraping if direct fetch gets IP-blocked |
| `ALL_FACTORS_HARD_GATE`, `DYNAMIC_LEVELS_HARD_GATE` | Tuning flags for the signal engine's gate strictness |
| `MIN_STRIKE_OI`, `MIN_STRIKE_VOLUME` | Liquidity floors used when picking a strike |
| `SCALP_ALERTS_ENABLED` | Toggle scalp-specific Telegram alerts |

For the full picture with inline descriptions, see `.env.example`.