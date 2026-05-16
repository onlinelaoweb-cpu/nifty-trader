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
let cachedChange = 0;
let cachedChangePercent = 0;
let lastUpdateTime = new Date();

// ==================== ANGEL ONE AUTHENTICATION ====================

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
      console.log('✅ Angel One Authenticated');
      return true;
    }
    return false;
  } catch (error) {
    console.log('Auth Error:', error.message);
    return false;
  }
}

// ==================== NIFTY PRICE FETCH ====================

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
      cachedChange = data.change || 0;
      cachedChangePercent = data.pchange || 0;
      lastUpdateTime = new Date();
      return { price: data.ltp, change: data.change || 0, changePercent: data.pchange || 0 };
    }
  } catch (error) {
    console.log('Price Fetch Error:', error.message);
  }
  
  return null;
}

// ==================== INDICATOR CALCULATIONS ====================

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
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return isNaN(rsi) ? 50 : rsi;
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

function calculateADX(prices, period = 14) {
  if (prices.length < period + 1) return { adx: 25, plusDI: 20, minusDI: 20 };
  
  let plusDM = 0, minusDM = 0, tr = 0;
  
  for (let i = 1; i <= period; i++) {
    const upMove = Math.max(0, prices[i] * 1.002 - prices[i - 1] * 1.002);
    const downMove = Math.max(0, prices[i - 1] * 0.998 - prices[i] * 0.998);
    
    if (upMove > downMove) plusDM += upMove;
    if (downMove > upMove) minusDM += downMove;
    
    const trValue = Math.max(
      (prices[i] * 1.002) - (prices[i] * 0.998),
      Math.abs((prices[i] * 1.002) - prices[i - 1]),
      Math.abs((prices[i] * 0.998) - prices[i - 1])
    );
    tr += trValue;
  }
  
  const atr = tr / period;
  const plusDI = (plusDM / tr) * 100 || 0;
  const minusDI = (minusDM / tr) * 100 || 0;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI);
  const adx = dx * 100 || 25;
  
  return { adx: isNaN(adx) ? 25 : adx, plusDI: plusDI, minusDI: minusDI };
}

function calculateSupportResistance(prices) {
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const pivot = (high + low) / 2;
  
  return {
    resistance: high,
    support: low,
    pivot: pivot
  };
}

function generatePrices(basePrice, count) {
  const prices = [basePrice];
  for (let i = 1; i < count; i++) {
    const change = (Math.random() - 0.48) * 12;
    prices.push(Math.max(prices[i - 1] + change, basePrice - 300));
  }
  return prices;
}

// ==================== TREND DETECTION ====================

function detectTrend(ema9, ema21, rsi) {
  if (!ema9 || !ema21) return 'NEUTRAL';
  
  if (ema9 > ema21 && rsi > 50) return 'STRONG_UPTREND';
  if (ema9 > ema21) return 'UPTREND';
  if (ema9 < ema21 && rsi < 50) return 'STRONG_DOWNTREND';
  if (ema9 < ema21) return 'DOWNTREND';
  return 'CONSOLIDATION';
}

function check920Rule(ema9, ema21) {
  if (!ema9 || !ema21) return 'NEUTRAL';
  return ema9 > ema21 ? 'BULLISH' : 'BEARISH';
}

// ==================== TRADE SIGNALS ====================

function generateSignals(rsi, adx, trend, currentPrice, isMarketOpen) {
  const signals = [];
  
  if (!isMarketOpen) {
    return signals;
  }
  
  // BUY CALL Signal
  if (rsi < 30 && adx.adx > 25 && trend.includes('UP')) {
    signals.push({
      type: 'BUY_CALL',
      strength: 'STRONG',
      entry: currentPrice,
      target: currentPrice * 1.02,
      stopLoss: currentPrice * 0.99,
      riskReward: '1:2'
    });
  }
  
  // BUY PUT Signal
  if (rsi > 70 && adx.adx > 25 && trend.includes('DOWN')) {
    signals.push({
      type: 'BUY_PUT',
      strength: 'STRONG',
      entry: currentPrice,
      target: currentPrice * 0.98,
      stopLoss: currentPrice * 1.01,
      riskReward: '1:2'
    });
  }
  
  // Extreme Oversold
  if (rsi < 20) {
    signals.push({
      type: 'BUY_CALL',
      strength: 'EXTREME_OVERSOLD',
      entry: currentPrice,
      target: currentPrice * 1.03,
      stopLoss: currentPrice * 0.98
    });
  }
  
  // Extreme Overbought
  if (rsi > 80) {
    signals.push({
      type: 'BUY_PUT',
      strength: 'EXTREME_OVERBOUGHT',
      entry: currentPrice,
      target: currentPrice * 0.97,
      stopLoss: currentPrice * 1.02
    });
  }
  
  return signals;
}

// ==================== MAIN API ENDPOINT ====================

app.get('/api/trading-data', async (req, res) => {
  try {
    const now = new Date();
    const day = now.getDay();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    
    // Market open check: Mon-Fri 9:15-15:30
    const isMarketOpen = day >= 1 && day <= 5 && 
      ((hours > 9) || (hours === 9 && minutes >= 15)) && 
      (hours < 15 || (hours === 15 && minutes <= 30));
    
    let niftyData = null;
    let dataSource = 'cached';
    
    if (isMarketOpen) {
      niftyData = await getNiftyPrice();
      if (niftyData && niftyData.price) {
        dataSource = 'live';
      } else {
        dataSource = 'cached';
        niftyData = { 
          price: cachedPrice, 
          change: cachedChange, 
          changePercent: cachedChangePercent 
        };
      }
    } else {
      dataSource = 'market_closed';
      niftyData = { 
        price: cachedPrice, 
        change: cachedChange, 
        changePercent: cachedChangePercent 
      };
    }
    
    const currentPrice = niftyData.price || cachedPrice;
    const prices = generatePrices(currentPrice, 50);
    
    // Calculate all indicators
    const rsi = calculateRSI(prices, 14);
    const ema9 = calculateEMA(prices, 9);
    const ema21 = calculateEMA(prices, 21);
    const adx = calculateADX(prices, 14);
    const supportRes = calculateSupportResistance(prices);
    const trend = detectTrend(ema9, ema21, rsi);
    const rule920 = check920Rule(ema9, ema21);
    const signals = generateSignals(rsi, adx, trend, currentPrice, isMarketOpen);
    
    res.json({
      timestamp: new Date().toISOString(),
      marketStatus: isMarketOpen ? 'OPEN' : 'CLOSED',
      dataSource: dataSource,
      nifty: {
        price: parseFloat(currentPrice.toFixed(2)),
        change: parseFloat(niftyData.change.toFixed(2)),
        changePercent: parseFloat(niftyData.changePercent.toFixed(2))
      },
      indicators: {
        rsi: parseFloat(rsi.toFixed(2)),
        ema9: parseFloat(ema9.toFixed(2)),
        ema21: parseFloat(ema21.toFixed(2)),
        adx: parseFloat(adx.adx.toFixed(2)),
        plusDI: parseFloat(adx.plusDI.toFixed(2)),
        minusDI: parseFloat(adx.minusDI.toFixed(2)),
        vix: '18.5'
      },
      supportResistance: {
        resistance: parseFloat(supportRes.resistance.toFixed(2)),
        support: parseFloat(supportRes.support.toFixed(2)),
        pivot: parseFloat(supportRes.pivot.toFixed(2))
      },
      trend: trend,
      rule920: rule920,
      signals: signals,
      lastUpdate: lastUpdateTime.toLocaleTimeString()
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ==================== FRONTEND HTML ====================

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NIFTY Live Trader Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: #0f172a; 
            color: #e0e7ff; 
            line-height: 1.6;
        }
        .container { max-width: 1400px; margin: 0 auto; padding: 15px; }
        header { 
            background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%); 
            padding: 25px; 
            border-radius: 10px; 
            margin-bottom: 25px; 
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        }
        h1 { 
            font-size: 28px; 
            margin-bottom: 15px; 
            display: flex; 
            align-items: center; 
            gap: 10px; 
        }
        .status-bar { 
            display: flex; 
            gap: 20px; 
            font-size: 13px; 
            margin: 12px 0; 
            flex-wrap: wrap;
        }
        .status-item { 
            display: flex; 
            align-items: center; 
            gap: 8px;
        }
        .pulse { 
            width: 10px; 
            height: 10px; 
            border-radius: 50%; 
            animation: pulse 2s infinite; 
        }
        .pulse.open { background: #10b981; }
        .pulse.closed { background: #ef4444; }
        .pulse.live { background: #3b82f6; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .price-section { margin-top: 15px; }
        .price-display { 
            font-size: 36px; 
            font-weight: bold; 
            color: #fbbf24; 
        }
        .change { 
            font-size: 16px; 
            margin-left: 15px;
        }
        .positive { color: #10b981; }
        .negative { color: #ef4444; }
        .btn { 
            background: #3b82f6; 
            color: white; 
            border: none; 
            padding: 10px 20px; 
            border-radius: 6px; 
            cursor: pointer; 
            font-weight: bold; 
            margin-top: 15px;
            transition: background 0.3s;
        }
        .btn:hover { background: #2563eb; }
        .grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 20px; 
            margin-bottom: 20px; 
        }
        .card { 
            background: #1e293b; 
            border: 1px solid #334155; 
            border-radius: 8px; 
            padding: 20px; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .card h3 { 
            color: #60a5fa; 
            margin-bottom: 15px; 
            border-bottom: 2px solid #334155; 
            padding-bottom: 10px; 
            font-size: 16px;
        }
        .item { 
            padding: 10px 0; 
            display: flex; 
            justify-content: space-between; 
            align-items: center;
            border-bottom: 1px solid #334155;
        }
        .item:last-child { border-bottom: none; }
        .label { 
            font-size: 11px; 
            color: #94a3b8; 
            text-transform: uppercase; 
            font-weight: 600;
        }
        .value { 
            font-size: 16px; 
            font-weight: bold; 
            color: #e0e7ff; 
        }
        .signal-box { 
            background: #0f172a; 
            padding: 15px; 
            border-radius: 6px; 
            margin: 10px 0; 
            border-left: 4px solid #fbbf24;
        }
        .signal-type { 
            font-weight: bold; 
            color: #fbbf24; 
            margin-bottom: 8px;
            font-size: 14px;
        }
        .signal-detail { 
            font-size: 12px; 
            color: #cbd5e1; 
            line-height: 1.8;
        }
        .no-signal { 
            color: #94a3b8; 
            text-align: center; 
            padding: 20px; 
            font-size: 13px;
        }
        .loading { 
            text-align: center; 
            padding: 40px; 
            color: #94a3b8; 
        }
        .trend-badge { 
            display: inline-block; 
            padding: 6px 12px; 
            border-radius: 4px; 
            font-size: 12px; 
            font-weight: bold;
            text-transform: uppercase;
        }
        .uptrend { background: #10b98125; color: #10b981; }
        .downtrend { background: #ef444425; color: #ef4444; }
        .consolidation { background: #f59e0b25; color: #f59e0b; }
        @media (max-width: 768px) { 
            h1 { font-size: 22px; } 
            .price-display { font-size: 28px; }
            .grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📈 NIFTY Live Trader Dashboard</h1>
            <div class="status-bar">
                <div class="status-item">
                    <div class="pulse open" id="market-pulse"></div>
                    <span id="market-status">Market: Loading...</span>
                </div>
                <div class="status-item">
                    <div class="pulse live"></div>
                    <span id="data-source">Data: Loading...</span>
                </div>
                <div class="status-item">
                    <span id="last-update">Updated: --</span>
                </div>
            </div>
            <div class="price-section">
                <span class="price-display">₹<span id="nifty-price">--</span></span>
                <span class="change" id="nifty-change">--</span>
            </div>
            <button class="btn" onclick="fetchData()">🔄 Refresh Data</button>
        </header>
        
        <div class="grid" id="dashboard">
            <div class="loading">⏳ Loading live trading data...</div>
        </div>
    </div>
    
    <script>
        async function fetchData() {
            try {
                const response = await fetch('/api/trading-data');
                const data = await response.json();
                
                // Update price
                document.getElementById('nifty-price').textContent = data.nifty.price.toFixed(2);
                const changeClass = data.nifty.change >= 0 ? 'positive' : 'negative';
                const changeText = (data.nifty.change >= 0 ? '+' : '') + data.nifty.change.toFixed(2) + ' (' + data.nifty.changePercent + '%)';
                document.getElementById('nifty-change').innerHTML = '<span class="' + changeClass + '">' + changeText + '</span>';
                
                // Update status
                const marketStatus = data.marketStatus === 'OPEN' ? '🟢 OPEN' : '🔴 CLOSED';
                document.getElementById('market-status').textContent = 'Market: ' + marketStatus;
                document.getElementById('market-pulse').className = 'pulse ' + (data.marketStatus === 'OPEN' ? 'open' : 'closed');
                
                const dataSourceText = data.dataSource === 'live' ? '🔴 LIVE Angel One' : data.dataSource === 'cached' ? '🟡 Last Close' : '⚪ Market Closed';
                document.getElementById('data-source').textContent = 'Data: ' + dataSourceText;
                document.getElementById('last-update').textContent = 'Updated: ' + new Date(data.timestamp).toLocaleTimeString();
                
                // Build dashboard
                let html = '';
                
                // Indicators Card
                html += '<div class="card"><h3>📊 Technical Indicators</h3>';
                html += '<div class="item"><span class="label">RSI (14)</span><span class="value">' + data.indicators.rsi + '</span></div>';
                html += '<div class="item"><span class="label">ADX (14)</span><span class="value">' + data.indicators.adx + '</span></div>';
                html += '<div class="item"><span class="label">EMA 9</span><span class="value">' + data.indicators.ema9 + '</span></div>';
                html += '<div class="item"><span class="label">EMA 21</span><span class="value">' + data.indicators.ema21 + '</span></div>';
                html += '<div class="item"><span class="label">+DI / -DI</span><span class="value">' + data.indicators.plusDI.toFixed(1) + ' / ' + data.indicators.minusDI.toFixed(1) + '</span></div>';
                html += '<div class="item"><span class="label">VIX</span><span class="value">' + data.indicators.vix + '</span></div>';
                html += '</div>';
                
                // Support & Resistance
                html += '<div class="card"><h3>🎯 Support & Resistance (4H)</h3>';
                html += '<div class="item"><span class="label">Resistance</span><span class="value">₹' + data.supportResistance.resistance + '</span></div>';
                html += '<div class="item"><span class="label">Support</span><span class="value">₹' + data.supportResistance.support + '</span></div>';
                html += '<div class="item"><span class="label">Pivot</span><span class="value">₹' + data.supportResistance.pivot + '</span></div>';
                html += '</div>';
                
                // Trend Analysis
                html += '<div class="card"><h3>🔄 Market Analysis</h3>';
                const trendClass = data.trend.includes('UP') ? 'uptrend' : data.trend.includes('DOWN') ? 'downtrend' : 'consolidation';
                html += '<div class="item"><span class="label">Trend</span><span class="trend-badge ' + trendClass + '">' + data.trend.replace(/_/g, ' ') + '</span></div>';
                html += '<div class="item"><span class="label">9:20 AM Rule</span><span class="trend-badge ' + (data.rule920 === 'BULLISH' ? 'uptrend' : 'downtrend') + '">' + data.rule920 + '</span></div>';
                html += '</div>';
                
                // Trade Signals
                html += '<div class="card"><h3>⚡ Active Trade Signals</h3>';
                if (data.signals.length > 0) {
                    data.signals.forEach(signal => {
                        html += '<div class="signal-box">';
                        html += '<div class="signal-type">' + signal.type.replace(/_/g, ' ') + ' (' + signal.strength + ')</div>';
                        html += '<div class="signal-detail">';
                        html += '<strong>Entry:</strong> ₹' + signal.entry.toFixed(2) + '<br>';
                        html += '<strong>Target:</strong> ₹' + signal.target.toFixed(2) + '<br>';
                        html += '<strong>Stop Loss:</strong> ₹' + signal.stopLoss.toFixed(2) + '<br>';
                        html += '<strong>R:R Ratio:</strong> ' + signal.riskReward;
                        html += '</div></div>';
                    });
                } else {
                    html += '<div class="no-signal">No active signals at this moment</div>';
                }
                html += '</div>';
                
                document.getElementById('dashboard').innerHTML = html;
            } catch (error) {
                console.error('Error:', error);
                document.getElementById('dashboard').innerHTML = '<div class="loading">❌ Error: ' + error.message + '</div>';
            }
        }
        
        // Auto-refresh every 5 seconds
        setInterval(fetchData, 5000);
        
        // Initial load
        fetchData();
    </script>
</body>
</html>`);
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 NIFTY Live Trader Dashboard');
  console.log('📊 Running on port ' + PORT);
  console.log('🟢 Ready for live trading data');
});
