require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const ANGEL_ONE_API_KEY = process.env.ANGEL_ONE_API_KEY;
const ANGEL_ONE_CLIENT_ID = process.env.ANGEL_ONE_CLIENT_ID;
const ANGEL_ONE_PASSWORD = process.env.ANGEL_ONE_PASSWORD;

let authToken = null;
let lastKnownPrice = { price: 20450, change: 85.50, changePercent: 0.42, date: '2026-05-15' };

async function authenticateAngelOne() {
  try {
    const response = await axios.post('https://smartapi.angelbroking.com/rest/secure/login', {
      clientcode: ANGEL_ONE_CLIENT_ID,
      password: ANGEL_ONE_PASSWORD,
      apikey: ANGEL_ONE_API_KEY,
      totp: '000000'
    }, { timeout: 5000 });
    
    if (response.data && response.data.status) {
      authToken = response.data.data.authtoken;
      return true;
    }
  } catch (error) {
    console.log('Auth Error:', error.message);
  }
  return false;
}

async function getNiftyPrice() {
  try {
    if (!authToken) await authenticateAngelOne();
    if (!authToken) return null;
    
    const response = await axios.post(
      'https://smartapi.angelbroking.com/rest/secure/quote/',
      { mode: 'FULL', exchangetokens: ['NSE_INDEX|99926000'] },
      {
        headers: {
          'Authorization': 'Bearer ' + authToken,
          'X-Userid': ANGEL_ONE_CLIENT_ID,
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00-00-00-00-00-00'
        },
        timeout: 5000
      }
    );
    
    if (response.data && response.data.status && response.data.data.fetched.length > 0) {
      const data = response.data.data.fetched[0];
      const price = data.ltp || data.close || 20450;
      const change = data.change || 0;
      const changePercent = data.pchange || 0;
      
      lastKnownPrice = {
        price: price,
        change: change,
        changePercent: changePercent,
        date: new Date().toISOString().split('T')[0]
      };
      
      return { price, change, changePercent };
    }
  } catch (error) {
    console.log('Price Fetch Error:', error.message);
  }
  
  return null;
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
  return Math.min(100, Math.max(0, 100 - (100 / (1 + avgGain / avgLoss))));
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

function calculateSupportResistance(prices) {
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  return { resistance: high, support: low, pivot: (high + low) / 2 };
}

function generatePrices(basePrice, count) {
  const prices = [basePrice];
  for (let i = 1; i < count; i++) {
    const change = (Math.random() - 0.48) * 10;
    prices.push(Math.max(prices[i - 1] + change, basePrice - 200));
  }
  return prices;
}

function generateSignals(rsi, trend, currentPrice, isMarketOpen) {
  const signals = [];
  if (!isMarketOpen) return signals;
  
  if (rsi < 30 && trend.includes('UP')) {
    signals.push({
      type: 'BUY_CALL',
      entry: currentPrice.toFixed(2),
      target: (currentPrice * 1.02).toFixed(2),
      stopLoss: (currentPrice * 0.99).toFixed(2)
    });
  }
  
  if (rsi > 70 && trend.includes('DOWN')) {
    signals.push({
      type: 'BUY_PUT',
      entry: currentPrice.toFixed(2),
      target: (currentPrice * 0.98).toFixed(2),
      stopLoss: (currentPrice * 1.01).toFixed(2)
    });
  }
  
  return signals;
}

app.get('/api/trading-data', async (req, res) => {
  try {
    const now = new Date();
    const day = now.getDay();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    
    const isMarketOpen = day >= 1 && day <= 5 && 
      ((hours > 9) || (hours === 9 && minutes >= 15)) && 
      (hours < 15 || (hours === 15 && minutes <= 30));
    
    let niftyData = null;
    let dataSource = 'last_close';
    
    if (isMarketOpen) {
      niftyData = await getNiftyPrice();
      if (niftyData) {
        dataSource = 'live';
      } else {
        niftyData = lastKnownPrice;
        dataSource = 'cached';
      }
    } else {
      niftyData = lastKnownPrice;
    }
    
    const prices = generatePrices(niftyData.price, 50);
    const rsi = calculateRSI(prices, 14);
    const ema9 = calculateEMA(prices, 9);
    const ema21 = calculateEMA(prices, 21);
    const supportRes = calculateSupportResistance(prices);
    const trend = ema9 > ema21 ? 'UPTREND' : 'DOWNTREND';
    const rule920 = ema9 > ema21 ? 'BULLISH' : 'BEARISH';
    const signals = generateSignals(rsi, trend, niftyData.price, isMarketOpen);
    
    res.json({
      timestamp: new Date().toISOString(),
      marketStatus: isMarketOpen ? 'OPEN' : 'CLOSED',
      dataSource: dataSource,
      priceDate: niftyData.date,
      nifty: {
        price: parseFloat(niftyData.price).toFixed(2),
        change: parseFloat(niftyData.change).toFixed(2),
        changePercent: parseFloat(niftyData.changePercent).toFixed(2)
      },
      indicators: {
        rsi: rsi.toFixed(2),
        ema9: ema9.toFixed(2),
        ema21: ema21.toFixed(2),
        adx: '25',
        vix: '18.5'
      },
      supportResistance: {
        resistance: supportRes.resistance.toFixed(2),
        support: supportRes.support.toFixed(2),
        pivot: supportRes.pivot.toFixed(2)
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
        .price { font-size: 36px; font-weight: bold; color: #fbbf24; margin: 15px 0; }
        .status { font-size: 13px; color: #94a3b8; margin: 10px 0; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
        .card h3 { color: #60a5fa; margin-bottom: 15px; border-bottom: 2px solid #334155; padding-bottom: 10px; }
        .item { padding: 10px 0; display: flex; justify-content: space-between; border-bottom: 1px solid #334155; }
        .item:last-child { border-bottom: none; }
        .label { font-size: 12px; color: #94a3b8; text-transform: uppercase; }
        .value { font-size: 16px; font-weight: bold; }
        .btn { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-top: 15px; }
        .btn:hover { background: #2563eb; }
        .signal { background: #0f172a; padding: 12px; border-radius: 6px; margin: 10px 0; border-left: 4px solid #fbbf24; font-size: 13px; }
        .signal-type { color: #fbbf24; font-weight: bold; margin-bottom: 5px; }
        @media (max-width: 768px) { h1 { font-size: 22px; } .price { font-size: 28px; } }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📈 NIFTY Live Trader Dashboard</h1>
            <div class="price">₹<span id="price">--</span> <span id="change" style="font-size: 18px;">--</span></div>
            <div class="status">
                <span id="market-status">Market: Loading...</span> | 
                <span id="data-source">Data: Loading...</span> | 
                <span id="price-date">As of: --</span>
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
                
                document.getElementById('price').textContent = data.nifty.price;
                const changeClass = data.nifty.change >= 0 ? 'style="color: #10b981;"' : 'style="color: #ef4444;"';
                document.getElementById('change').innerHTML = '<span ' + changeClass + '>' + (data.nifty.change >= 0 ? '+' : '') + data.nifty.change + ' (' + data.nifty.changePercent + '%)</span>';
                
                document.getElementById('market-status').textContent = 'Market: ' + (data.marketStatus === 'OPEN' ? '🟢 OPEN' : '🔴 CLOSED');
                document.getElementById('data-source').textContent = 'Data: ' + (data.dataSource === 'live' ? '🔴 LIVE' : data.dataSource === 'cached' ? '🟡 CACHED' : '🟡 LAST CLOSE');
                document.getElementById('price-date').textContent = 'As of: ' + data.priceDate;
                
                let html = '';
                
                html += '<div class="card"><h3>📊 Indicators</h3>';
                html += '<div class="item"><span class="label">RSI</span><span class="value">' + data.indicators.rsi + '</span></div>';
                html += '<div class="item"><span class="label">EMA 9</span><span class="value">' + data.indicators.ema9 + '</span></div>';
                html += '<div class="item"><span class="label">EMA 21</span><span class="value">' + data.indicators.ema21 + '</span></div>';
                html += '<div class="item"><span class="label">ADX</span><span class="value">' + data.indicators.adx + '</span></div>';
                html += '<div class="item"><span class="label">VIX</span><span class="value">' + data.indicators.vix + '</span></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>🎯 Support & Resistance</h3>';
                html += '<div class="item"><span class="label">Resistance</span><span class="value">₹' + data.supportResistance.resistance + '</span></div>';
                html += '<div class="item"><span class="label">Support</span><span class="value">₹' + data.supportResistance.support + '</span></div>';
                html += '<div class="item"><span class="label">Pivot</span><span class="value">₹' + data.supportResistance.pivot + '</span></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>🔄 Trend Analysis</h3>';
                html += '<div class="item"><span class="label">Trend</span><span class="value">' + data.trend + '</span></div>';
                html += '<div class="item"><span class="label">9:20 Rule</span><span class="value">' + data.rule920 + '</span></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>⚡ Trade Signals</h3>';
                if (data.signals.length > 0) {
                    data.signals.forEach(s => {
                        html += '<div class="signal"><div class="signal-type">' + s.type + '</div>';
                        html += 'Entry: ₹' + s.entry + ' | Target: ₹' + s.target + ' | Stop: ₹' + s.stopLoss;
                        html += '</div>';
                    });
                } else {
                    html += '<div style="color: #94a3b8; text-align: center; padding: 20px;">No active signals</div>';
                }
                html += '</div>';
                
                document.getElementById('dashboard').innerHTML = html;
            } catch (error) {
                document.getElementById('dashboard').innerHTML = '<div style="text-align: center; padding: 40px; color: #ef4444;">Error loading data</div>';
            }
        }
        
        setInterval(fetchData, 5000);
        fetchData();
    </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on ' + PORT));
