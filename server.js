require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const ANGEL_ONE_API_KEY = process.env.ANGEL_ONE_API_KEY;
const ANGEL_ONE_CLIENT_ID = process.env.ANGEL_ONE_CLIENT_ID;
const ANGEL_ONE_PASSWORD = process.env.ANGEL_ONE_PASSWORD;

let authToken = null;
let cachedPrice = 20300;

async function authenticateAngelOne() {
  try {
    const response = await axios.post('https://smartapi.angelbroking.com/rest/secure/login', {
      clientcode: ANGEL_ONE_CLIENT_ID,
      password: ANGEL_ONE_PASSWORD,
      apikey: ANGEL_ONE_API_KEY,
      totp: '000000'
    });
    
    if (response.data.status) {
      authToken = response.data.data.authtoken;
      console.log('✅ Auth Success');
      return true;
    }
    return false;
  } catch (error) {
    console.log('Auth error:', error.message);
    return false;
  }
}

async function getNiftyPrice() {
  try {
    if (!authToken) {
      await authenticateAngelOne();
    }
    
    const response = await axios.post(
      'https://smartapi.angelbroking.com/rest/secure/quote/',
      {
        mode: 'LTP',
        exchangetokens: ['NSE_INDEX|99926000']
      },
      {
        headers: {
          'Authorization': 'Bearer ' + authToken,
          'X-Userid': ANGEL_ONE_CLIENT_ID,
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00-00-00-00-00-00'
        }
      }
    );
    
    if (response.data.status && response.data.data.fetched.length > 0) {
      const data = response.data.data.fetched[0];
      cachedPrice = data.ltp || cachedPrice;
      return { price: data.ltp, change: data.change || 0, changePercent: data.pchange || 0 };
    }
  } catch (error) {
    console.log('Price fetch error:', error.message);
  }
  
  return { price: cachedPrice, change: 0, changePercent: 0 };
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }
  
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function generatePrices(basePrice, count) {
  const prices = [basePrice];
  for (let i = 1; i < count; i++) {
    const change = (Math.random() - 0.48) * 15;
    prices.push(Math.max(prices[i - 1] + change, basePrice - 500));
  }
  return prices;
}

app.get('/api/trading-data', async (req, res) => {
  try {
    const niftyData = await getNiftyPrice();
    const prices = generatePrices(niftyData.price, 50);
    
    const rsi = calculateRSI(prices);
    const ema9 = calculateEMA(prices, 9);
    const ema21 = calculateEMA(prices, 21);
    
    const trend = ema9 > ema21 ? 'UPTREND' : 'DOWNTREND';
    const rule920 = ema9 > ema21 ? 'BULLISH' : 'BEARISH';
    
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    
    let signals = [];
    if (rsi < 30 && ema9 > ema21) {
      signals.push({
        type: 'BUY_CALL',
        strength: 'STRONG',
        entry: niftyData.price,
        target: niftyData.price * 1.02,
        stopLoss: niftyData.price * 0.99,
        riskReward: '1:2'
      });
    }
    
    if (rsi > 70 && ema9 < ema21) {
      signals.push({
        type: 'BUY_PUT',
        strength: 'STRONG',
        entry: niftyData.price,
        target: niftyData.price * 0.98,
        stopLoss: niftyData.price * 1.01,
        riskReward: '1:2'
      });
    }
    
    res.json({
      timestamp: new Date().toISOString(),
      nifty: {
        price: niftyData.price,
        change: niftyData.change,
        changePercent: niftyData.changePercent
      },
      indicators: {
        rsi: rsi.toFixed(2),
        ema9: ema9.toFixed(2),
        ema21: ema21.toFixed(2),
        adx: '25',
        vix: '18.5'
      },
      supportResistance: {
        resistance: high.toFixed(2),
        support: low.toFixed(2),
        pivot: ((high + low) / 2).toFixed(2)
      },
      trend: trend,
      rule920: rule920,
      signals: signals
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NIFTY Live Trader</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #e0e7ff; }
        .container { max-width: 1200px; margin: 0 auto; padding: 15px; }
        header { background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%); padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        h1 { font-size: 28px; margin-bottom: 10px; }
        .price { font-size: 32px; font-weight: bold; color: #fbbf24; margin: 15px 0; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
        .card h3 { color: #60a5fa; margin-bottom: 15px; border-bottom: 2px solid #334155; padding-bottom: 10px; }
        .item { padding: 10px 0; display: flex; justify-content: space-between; }
        .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; }
        .value { font-size: 18px; font-weight: bold; }
        .btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; }
        .btn:hover { background: #2563eb; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📈 NIFTY Live Trader Dashboard</h1>
            <div class="price">
                ₹<span id="price">--</span> <span id="change" style="font-size: 18px;">--</span>
            </div>
            <button class="btn" onclick="fetchData()">🔄 Refresh</button>
        </header>
        
        <div class="grid" id="dashboard">
            <div style="text-align: center; padding: 40px; color: #94a3b8;">Loading...</div>
        </div>
    </div>
    
    <script>
        async function fetchData() {
            try {
                const res = await fetch('/api/trading-data');
                const data = await res.json();
                
                document.getElementById('price').textContent = data.nifty.price.toFixed(2);
                document.getElementById('change').textContent = (data.nifty.change >= 0 ? '+' : '') + data.nifty.change.toFixed(2);
                
                let html = '';
                
                html += '<div class="card"><h3>📊 Indicators</h3>';
                html += '<div class="item"><span class="label">RSI</span><span class="value">' + data.indicators.rsi + '</span></div>';
                html += '<div class="item"><span class="label">EMA 9</span><span class="value">' + data.indicators.ema9 + '</span></div>';
                html += '<div class="item"><span class="label">EMA 21</span><span class="value">' + data.indicators.ema21 + '</span></div>';
                html += '<div class="item"><span class="label">ADX</span><span class="value">' + data.indicators.adx + '</span></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>🎯 Support & Resistance</h3>';
                html += '<div class="item"><span class="label">Resistance</span><span class="value">₹' + data.supportResistance.resistance + '</span></div>';
                html += '<div class="item"><span class="label">Support</span><span class="value">₹' + data.supportResistance.support + '</span></div>';
                html += '<div class="item"><span class="label">Pivot</span><span class="value">₹' + data.supportResistance.pivot + '</span></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>🔄 Trend Analysis</h3>';
                html += '<div class="item"><span class="label">Trend</span><span class="value">' + data.trend + '</span></div>';
                html += '<div class="item"><span class="label">9:20 AM Rule</span><span class="value">' + data.rule920 + '</span></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>⚡ Signals</h3>';
                if (data.signals.length > 0) {
                    data.signals.forEach(s => {
                        html += '<div style="background: #0f172a; padding: 12px; border-radius: 6px; margin: 10px 0; border-left: 4px solid #fbbf24;">';
                        html += '<strong style="color: #fbbf24;">' + s.type + '</strong><br>';
                        html += 'Entry: ₹' + s.entry.toFixed(2) + '<br>';
                        html += 'Target: ₹' + s.target.toFixed(2) + '<br>';
                        html += 'Stop: ₹' + s.stopLoss.toFixed(2) + '<br>';
                        html += 'R:R: ' + s.riskReward + '</div>';
                    });
                } else {
                    html += '<p style="color: #94a3b8;">No active signals</p>';
                }
                html += '</div>';
                
                document.getElementById('dashboard').innerHTML = html;
            } catch (error) {
                document.getElementById('dashboard').innerHTML = '<div style="text-align: center; padding: 40px; color: #ef4444;">Error: ' + error.message + '</div>';
            }
        }
        
        setInterval(fetchData, 5000);
        fetchData();
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
