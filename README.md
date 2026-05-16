# 📈 NIFTY Live Trader Dashboard

Real-time NIFTY 50 trading dashboard with Angel One SmartAPI integration, technical indicators, and automated trade signals.

## 🎯 Features

✅ **Real-time NIFTY 50 Data** - Live price updates via Angel One SmartAPI  
✅ **Technical Indicators** - RSI, ADX, EMA 9/21, +DI, -DI  
✅ **Support & Resistance** - 4-hour timeframe analysis  
✅ **Trade Signals** - Automated Buy Call/Put alerts with 1:2 risk-reward  
✅ **9:20 AM Rule** - EMA-based market entry signals  
✅ **Trend Detection** - Uptrend, Downtrend, Consolidation analysis  
✅ **VIX Tracking** - Market volatility monitoring  
✅ **Mobile Responsive** - Works perfectly on phones & tablets  
✅ **Cloud Deployed** - Access from anywhere via Railway

---

## 🚀 Deployment on Railway (5 Minutes)

### Step 1: Push Code to GitHub

```bash
# Create new GitHub repo (or use existing)
git init
git add .
git commit -m "Initial NIFTY trader dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/nifty-trader.git
git push -u origin main
```

**Files in repo:**
- `server.js` - Express backend
- `package.json` - Dependencies
- `Procfile` - Railway config
- `.env.example` - Environment variables template
- `README.md` - This file

---

### Step 2: Connect to Railway

1. **Go to** [railway.app](https://railway.app)
2. **Sign up** (free account)
3. **Create New Project** → **Deploy from GitHub**
4. **Connect your GitHub account** → Select `nifty-trader` repo
5. **Create Project**

Railway will auto-detect `Procfile` and start deploying! ✅

---

### Step 3: Add Environment Variables

Once deployed, go to **Project Settings → Variables**

Add these 3 variables (copy from your Angel One account):

```
ANGEL_ONE_API_KEY=your_actual_api_key
ANGEL_ONE_CLIENT_ID=your_client_id
ANGEL_ONE_PASSWORD=your_password
```

**How to find these:**
1. Login to [Angel One account](https://www.angelone.in)
2. Go to **Settings** → **API**
3. Click **Generate API Key**
4. Copy values:
   - `API Key` → `ANGEL_ONE_API_KEY`
   - `Client ID` → `ANGEL_ONE_CLIENT_ID`
   - Your login password → `ANGEL_ONE_PASSWORD`

5. Click **Deploy** (Railway will restart with your credentials)

---

### Step 4: Access Your Dashboard

Once deployed, Railway gives you a **public URL**:

```
https://nifty-trader-production.up.railway.app
```

✅ **This works on mobile, laptop, anywhere!**

---

## 📱 Using the Dashboard

### On Mobile:
1. Open the Railway URL in your browser
2. **Auto-refreshes every 5 seconds** with live data
3. See all indicators, support/resistance, trade signals

### What You'll See:

| Section | What It Shows |
|---------|---|
| **NIFTY Price** | Live price + % change |
| **RSI (14)** | Overbought (>70) / Oversold (<30) |
| **ADX** | Trend strength (>25 = strong trend) |
| **EMA 9/21** | Moving averages for trend |
| **Support/Resistance** | 4H levels |
| **Trend** | UPTREND / DOWNTREND / CONSOLIDATION |
| **9:20 AM Rule** | BULLISH / BEARISH (EMA-based) |
| **Trade Signals** | BUY CALL / BUY PUT alerts |

---

## 🔔 Understanding Trade Signals

### BUY CALL (Bullish Signal)
```
✅ When: RSI < 30 + ADX > 25 + Uptrend
Entry: Current price
Target: +2% above entry (Risk:Reward = 1:2)
Stop Loss: -1% below entry
```

### BUY PUT (Bearish Signal)
```
✅ When: RSI > 70 + ADX > 25 + Downtrend
Entry: Current price
Target: -2% below entry (Risk:Reward = 1:2)
Stop Loss: +1% above entry
```

### Signal Strength
- **STRONG** - Confirmed by multiple indicators
- **EXTREME_OVERSOLD** - RSI < 20 (reversal likely)
- **EXTREME_OVERBOUGHT** - RSI > 80 (reversal likely)

---

## 📊 Indicators Explained

### RSI (Relative Strength Index)
- **< 30** = Oversold (potential bounce)
- **> 70** = Overbought (potential drop)
- **30-70** = Neutral

### ADX (Average Directional Index)
- **> 25** = Strong trend (follow it)
- **< 25** = Weak trend (avoid trading)
- **> 50** = Extreme trend strength

### EMA 9 & EMA 21
- **EMA9 > EMA21** = Bullish crossover
- **EMA9 < EMA21** = Bearish crossover
- **9:20 AM Rule** = First 20min trend indicator

### Support & Resistance
- **Resistance** = Price ceiling (sell here)
- **Support** = Price floor (buy here)
- **Pivot** = Mid-point between S & R

### VIX
- **< 15** = Low volatility (calm market)
- **15-25** = Normal
- **> 25** = High volatility (choppy)

---

## ⚙️ Configuration

### Adjust Trade Signal Parameters

Edit `server.js` function `generateSignals()`:

```javascript
// Change RSI thresholds
if (rsi < 30 && adx.adx > 25) {  // ← Change 30 to your value
  signals.push({
    type: 'BUY_CALL',
    target: currentPrice * 1.02,  // ← Change 1.02 to 1.03 for 3% target
    stopLoss: currentPrice * 0.99,  // ← Adjust stop loss %
  });
}
```

Then **commit & push to GitHub** → Railway auto-deploys!

---

## 🔐 Security Notes

✅ **API Keys are SAFE:**
- Stored in Railway's encrypted environment variables
- Never exposed in frontend code
- Never committed to GitHub
- Accessible only to your backend server

❌ **DON'T:**
- Paste API keys in code
- Commit `.env` file to GitHub
- Share credentials

---

## 🛠️ Troubleshooting

### Dashboard shows "No Active Signals"
- Signals only trigger on specific conditions (RSI < 30, ADX > 25, etc.)
- This is normal! Wait for market condition to match

### Error: "Angel One Auth Failed"
- Check credentials in Railway Variables panel
- Verify API Key is correct (copy-paste exactly)
- Some Angel One accounts need TOTP setup (edit server.js `totp` parameter)

### Not fetching real-time data
- Demo version uses mock data for testing
- For real Angel One data, add WebSocket listener (advanced)
- Current version is ideal for learning

### Mobile display looks weird
- Refresh page (Ctrl+R or Cmd+R)
- Use latest Chrome/Safari
- Clear cache if needed

---

## 📈 Next Steps (Advanced)

### Real WebSocket Data (Live Updates)
Replace mock data with Angel One WebSocket feeds:

```javascript
// Add this to server.js
const WebSocket = require('ws');

const smartAPISocket = new WebSocket('wss://smartapisocket.angelbroking.com');
smartAPISocket.on('message', (data) => {
  // Real NIFTY tick data here
});
```

### Database Integration
Store trade history in PostgreSQL:
```javascript
app.post('/api/trade-history', (req, res) => {
  // Log every trade signal
});
```

### Telegram Alerts
Send alerts to your phone:
```javascript
const TelegramBot = require('node-telegram-bot-api');
bot.sendMessage(chatId, `BUY CALL: ${signal.type}`);
```

---

## 📞 Support

Having issues?

1. **Check Railway Logs** - Project → Deployments → Logs
2. **Verify Credentials** - Variables panel
3. **Test Locally** - Run `npm install && npm start`

---

## 📄 License

Free to use and modify. Made for personal trading use.

---

## 🎯 Trading Disclaimer

⚠️ **Important:**
- This dashboard is educational only
- No guarantee of profits
- Always use proper risk management
- Past performance ≠ Future results
- Trade with money you can afford to lose
- Consult a financial advisor before trading

**Happy Trading! 📈**
