require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let authToken = null;
let feedToken = null;

// Calculate RSI
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains = change;
    else losses = Math.abs(change);

    avgGain = (avgGain * (period - 1) + gains) / period;
    avgLoss = (avgLoss * (period - 1) + losses) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return rsi;
}

// Calculate EMA
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];

  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

// Calculate ADX
function calculateADX(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return { adx: 25, plusDI: 20, minusDI: 20 };

  let plusDM = 0, minusDM = 0, tr = 0;

  for (let i = 1; i <= period; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;

    const trValue = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    tr += trValue;
  }

  const atr = tr / period;
  const plusDI = (plusDM / tr) * 100 || 0;
  const minusDI = (minusDM / tr) * 100 || 0;
  const adx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100 || 25;

  return { adx: isNaN(adx) ? 25 : adx, plusDI, minusDI };
}

// Calculate Support & Resistance
function calculateSupportResistance(prices) {
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const avg = (high + low) / 2;

  return { resistance: high, support: low, pivot: avg };
}

// Detect Trend
function detectTrend(ema9, ema21, rsi) {
  if (!ema9 || !ema21) return 'UNKNOWN';

  if (ema9 > ema21 && rsi > 50) return 'STRONG_UPTREND';
  if (ema9 > ema21) return 'UPTREND';
  if (ema9 < ema21 && rsi < 50) return 'STRONG_DOWNTREND';
  if (ema9 < ema21) return 'DOWNTREND';
  return 'CONSOLIDATION';
}

// 9:20 AM Rule
function check920Rule(ema9, ema21) {
  if (!ema9 || !ema21) return null;
  return ema9 > ema21 ? 'BULLISH' : 'BEARISH';
}

// Generate Trade Signals
function generateSignals(rsi, adx, trend, supportResistance, currentPrice) {
  const signals = [];

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

  if (rsi < 20) {
    signals.push({
      type: 'BUY_CALL',
      strength: 'EXTREME_OVERSOLD',
      entry: currentPrice,
      target: currentPrice * 1.03,
      stopLoss: currentPrice * 0.98
    });
  }

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

// Generate mock prices
function generateMockPrices(startPrice, count) {
  const prices = [startPrice];
  for (let i = 1; i < count; i++) {
    const change = (Math.random() - 0.48) * 20;
    prices.push(Math.max(prices[i - 1] + change, 19000));
  }
  return prices;
}

// API Endpoint
app.get('/api/trading-data', (req, res) => {
  try {
    const mockPrices = generateMockPrices(20300, 50);
    
    const rsi = calculateRSI(mockPrices, 14);
    const ema9 = calculateEMA(mockPrices, 9);
    const ema21 = calculateEMA(mockPrices, 21);
    const adx = calculateADX(
      mockPrices.map(p => p * 1.001),
      mockPrices.map(p => p * 0.999),
      mockPrices,
      14
    );
    const supportRes = calculateSupportResistance(mockPrices);
    const trend = detectTrend(ema9, ema21, rsi);
    const rule920 = check920Rule(ema9, ema21);
    const signals = generateSignals(rsi, adx, trend, supportRes, mockPrices[mockPrices.length - 1]);

    res.json({
      timestamp: new Date().toISOString(),
      nifty: {
        price: mockPrices[mockPrices.length - 1],
        change: mockPrices[mockPrices.length - 1] - mockPrices[0],
        changePercent: ((mockPrices[mockPrices.length - 1] - mockPrices[0]) / mockPrices[0] * 100).toFixed(2)
      },
      indicators: {
        rsi: rsi.toFixed(2),
        ema9: ema9.toFixed(2),
        ema21: ema21.toFixed(2),
        adx: adx.adx.toFixed(2),
        plusDI: adx.plusDI.toFixed(2),
        minusDI: adx.minusDI.toFixed(2),
        vix: (18.5).toFixed(2)
      },
      supportResistance: {
        resistance: supportRes.resistance.toFixed(2),
        support: supportRes.support.toFixed(2),
        pivot: supportRes.pivot.toFixed(2)
      },
      trend: trend,
      rule920: rule920,
      signals: signals,
      candleData: mockPrices.slice(-20).map((price, i) => ({
        time: new Date(Date.now() - (20 - i) * 15 * 60000).toISOString(),
        open: price * (0.999 + Math.random() * 0.002),
        high: price * (1.001 + Math.random() * 0.002),
        low: price * (0.998 + Math.random() * 0.002),
        close: price
      }))
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// HTML Frontend
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NIFTY Live Trader Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #e0e7ff; }
        .container { max-width: 1400px; margin: 0 auto; padding: 15px; }
        header { background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%); padding: 20px; border-radius: 10px; margin-bottom: 20px; }
        h1 { font-size: 28px; margin-bottom: 10px; }
        .price-display { font-size: 32px; font-weight: bold; color: #fbbf24; margin-top: 10px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
        .card h3 { color: #60a5fa; margin-bottom: 15px; border-bottom: 2px solid #334155; padding-bottom: 10px; }
        .indicator { background: #0f172a; padding: 12px; border-radius: 6px; border-left: 4px solid #60a5fa; margin: 10px 0; }
        .indicator-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; }
        .indicator-value { font-size: 20px; font-weight: bold; color: #e0e7ff; }
        .refresh-button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; margin: 10px 0; }
        .refresh-button:hover { background: #2563eb; }
        .loading { text-align: center; padding: 20px; color: #94a3b8; }
        @media (max-width: 768px) { h1 { font-size: 20px; } .price-display { font-size: 24px; } }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📈 NIFTY Live Trader Dashboard</h1>
            <div class="price-display">
                ₹<span id="nifty-price">--</span>
                <span id="nifty-change" style="font-size: 18px;">--</span>
            </div>
            <button class="refresh-button" onclick="fetchData()">🔄 Refresh Data</button>
        </header>
        <div class="grid" id="dashboard">
            <div class="loading">⏳ Loading trading data...</div>
        </div>
    </div>
    <script>
        async function fetchData() {
            try {
                const response = await fetch('/api/trading-data');
                const data = await response.json();
                
                document.getElementById('nifty-price').textContent = data.nifty.price.toFixed(2);
                document.getElementById('nifty-change').textContent = data.nifty.change >= 0 ? '+' + data.nifty.change.toFixed(2) : data.nifty.change.toFixed(2);
                
                let html = '<div class="card"><h3>📊 Indicators</h3>';
                html += '<div class="indicator"><div class="indicator-label">RSI</div><div class="indicator-value">' + data.indicators.rsi + '</div></div>';
                html += '<div class="indicator"><div class="indicator-label">ADX</div><div class="indicator-value">' + data.indicators.adx + '</div></div>';
                html += '<div class="indicator"><div class="indicator-label">EMA9</div><div class="indicator-value">' + data.indicators.ema9 + '</div></div>';
                html += '<div class="indicator"><div class="indicator-label">EMA21</div><div class="indicator-value">' + data.indicators.ema21 + '</div></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>🎯 Support & Resistance</h3>';
                html += '<div class="indicator"><div class="indicator-label">Resistance</div><div class="indicator-value">₹' + data.supportResistance.resistance + '</div></div>';
                html += '<div class="indicator"><div class="indicator-label">Support</div><div class="indicator-value">₹' + data.supportResistance.support + '</div></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>🔄 Trend</h3>';
                html += '<div class="indicator"><div class="indicator-label">' + data.trend + '</div><div class="indicator-value">' + (data.rule920 || 'N/A') + '</div></div>';
                html += '</div>';
                
                html += '<div class="card"><h3>⚡ Signals</h3>';
                if (data.signals.length > 0) {
                    data.signals.forEach(signal => {
                        html += '<div class="indicator"><div class="indicator-label">' + signal.type + '</div><div class="indicator-value">Entry: ₹' + signal.entry.toFixed(2) + '</div></div>';
                    });
                } else {
                    html += '<div class="loading">No active signals</div>';
                }
                html += '</div>';
                
                document.getElementById('dashboard').innerHTML = html;
            } catch (error) {
                console.error('Error:', error);
                document.getElementById('dashboard').innerHTML = '<div class="loading">Error: ' + error.message + '</div>';
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
