# ⚡ Quick Start Guide (5 Minutes)

## Step 1: Prepare Your Credentials

Before you start, collect these from Angel One:

```
ANGEL_ONE_API_KEY = [from Angel One dashboard]
ANGEL_ONE_CLIENT_ID = [your account ID]
ANGEL_ONE_PASSWORD = [your login password]
```

⚠️ **DON'T SHARE THESE** - Keep them private!

---

## Step 2: Create GitHub Repository

```bash
# Clone this project
git clone https://github.com/YOUR_USERNAME/nifty-trader.git
cd nifty-trader

# Or if starting fresh:
git init
git add .
git commit -m "NIFTY Trader Dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/nifty-trader.git
git push -u origin main
```

---

## Step 3: Deploy on Railway (Click-Click!)

1. **Go to**: https://railway.app (Sign up free)
2. **Dashboard** → **Create Project** → **Deploy from GitHub**
3. **Connect GitHub** → Select `nifty-trader`
4. **Create Project** → Railway starts deploying automatically! ✅

**Wait 1-2 minutes for deployment...**

---

## Step 4: Add Your Credentials

1. **Go to Your Railway Project**
2. **Settings Tab** → **Environment Variables**
3. **Add Variables**:

```
ANGEL_ONE_API_KEY=your_api_key
ANGEL_ONE_CLIENT_ID=your_client_id
ANGEL_ONE_PASSWORD=your_password
```

4. **Save** → Railway auto-redeploys ✅

---

## Step 5: Open Your Dashboard

Railway gives you a URL like:
```
https://nifty-trader-production.up.railway.app
```

**Click the link → Done!** 🎉

Your dashboard is now **live on the internet** and **accessible from mobile anywhere!**

---

## 📱 Access From Phone

1. Copy your Railway URL
2. Open in phone browser
3. Data auto-refreshes every 5 seconds
4. See live NIFTY price + all indicators
5. Get trade alerts!

---

## 🔄 Updates & Changes

Want to update the code?

```bash
# Make changes locally
git add .
git commit -m "Your changes"
git push origin main
```

Railway **auto-deploys** your changes! (Takes 1-2 min)

---

## ✅ You're Done!

Your professional live trading dashboard is now:
- ✅ Running 24/7 on the cloud
- ✅ Accessible from mobile anywhere
- ✅ Fetching real Angel One data
- ✅ Showing technical indicators
- ✅ Alerting you to trade signals

**Happy Trading!** 📈

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Cannot connect to Angel One" | Check API credentials in Railway Variables |
| Dashboard blank/loading | Wait 30sec, refresh page (may need to wake backend) |
| Indicators show 0 | Normal during market hours - live data only |
| Mobile view broken | Rotate phone to landscape or use landscape mode |

For more detailed info → See **README.md**
