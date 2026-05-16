require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Angel One SmartAPI Configuration
const ANGEL_ONE_API_KEY = process.env.ANGEL_ONE_API_KEY;
const ANGEL_ONE_CLIENT_ID = process.env.ANGEL_ONE_CLIENT_ID;
const ANGEL_ONE_PASSWORD = process.env.ANGEL_ONE_PASSWORD;
const ANGEL_ONE_API_URL = 'https://smartapi.angelbroking.com';

let authToken = null;
let feedToken = null;

// Authentication with Angel One
async function authenticateAngelOne() {
  try {
    const response = await axios.post(`${ANGEL_ONE_API_URL}/rest/secure/login`, {
      clientcode: ANGEL_ONE_CLIENT_ID,
      password: ANGEL_ONE_PASSWORD,
      apikey: ANGEL_ONE_API_KEY,
      totp: '000000' // For testing - you'll need TOTP if 2FA enabled
    });

    if (response.data.status) {
      authToken = response.data.data.authtoken;
      feedToken = response.data.data.feedtoken;
      console.log('✅ Angel One authenticated successfully');
      return true;
    }
  } catch (error) {
    console.error('❌ Angel One Auth Error:', error.response?.data || error.message);
    return false;
  }
}

// Fetch NIFTY 50 data
async function getNiftyData() {
  try {
    if (!authToken) {
      await authenticateAngelOne();
    }

    // NIFTY 50 token (NSE: 99926000)
    const response = await axios.post(
      `${ANGEL_ONE_API_URL}/rest/secure/quote/`,
      {
        mode: 'LTP',
        exchangetokens: ['NSE_INDEX|99926000'] // NIFTY 50
      },
      {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'X-Userid': ANGEL_ONE_CLIENT_ID,
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': '00-00-00-00-00-00'
        }
      }
    );

    if (response.data.status) {
      return response.data.data.fetched[0];
    }
  } catch (error) {
    console.error('Error fetching NIFTY data:', error.message);
    return null;
  }
}

// Calculate RSI
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

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

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return rsi;
}

// Calculate EMA
function calculateEMA(prices, period) {
  if (prices.length < period) return null;

  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

// Calculate ADX (simplified)
function calculateADX(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;

  let plusDM = 0, minusDM = 0, tr = 0;

  for (let i = 1; i <= period; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    if (upMove > downMove && upMove > 0) plusDM += upMove;
    else plusDM += 0;

    if (downMove > upMove && downMove > 0) minusDM += downMove;
    else minusDM += 0;

    const trValue = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    tr += trValue;
  }

  const atr = tr / period;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  const adx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;

  return { adx: adx || 0, plusDI, minusDI };
}

// Calculate Support & Resistance (4H timeframe)
function calculateSupportResistance(prices) {
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const avg = (high + low) / 2;

  return {
    resistance: high,
    support: low,
    pivot: avg
  };
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

// 9:20 AM Rule Logic
function check920Rule(ema9, ema21) {
  if (!ema9 || !ema21) return null;
  return ema9 > ema21 ? 'BULLISH' : 'BEARISH';
}

// Generate Trade Signals
function generateSignals(rsi, adx, trend, supportResistance, currentPrice) {
  const signals = [];

  // Buy Call Signal
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

  // Buy Put Signal
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

  // Oversold condition
  if (rsi < 20) {
    signals.push({
      type: 'BUY_CALL',
      strength: 'EXTREME_OVERSOLD',
      entry: currentPrice,
      target: currentPrice * 1.03,
      stopLoss: currentPrice * 0.98
    });
  }

  // Overbought condition
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

// API Endpoint: Get Trading Dashboard Data
app.get('/api/trading-data', async (req, res) => {
  try {
    // For demo: using mock data structure
    // In production: fetch real data from Angel One via WebSocket
    
    // Mock candlestick data for last 50 periods
    const mockPrices = generateMockPrices(20300, 50);
    
    const rsi = calculateRSI(mockPrices, 14);
    const ema9 = calculateEMA(mockPrices, 9);
    const ema21 = calculateEMA(mockPrices, 21);
    const adx = calculateADX(
      mockPrices.map(p => p * 1.001), // Mock highs
      mockPrices.map(p => p * 0.999), // Mock lows
      mockPrices,
      14
    );
    const supportRes = calculateSupportResistance(mockPrices);
    const trend = detectTrend(ema9, ema21, rsi);
    const rule920 = check920Rule(ema9, ema21);
    const signals = generateSignals(rsi, adx, trend, supportRes, mockPrices[mockPrices.length - 1]);

    // Fetch real VIX data from free API
    let vixData = null;
    try {
      const vixResponse = await axios.get('https://api.example.com/vix'); // Replace with actual VIX API
      vixData = vixResponse.data.vix || 18.5;
    } catch {
      vixData = 18.5; // Fallback
    }

    res.json({
      timestamp: new Date().toISOString(),
      nifty: {
        price: mockPrices[mockPrices.length - 1],
        change: mockPrices[mockPrices.length - 1] - mockPrices[0],
        changePercent: ((mockPrices[mockPrices.length - 1] - mockPrices[0]) / mockPrices[0] * 100).toFixed(2)
      },
      indicators: {
        rsi: rsi?.toFixed(2),
        ema9: ema9?.toFixed(2),
        ema21: ema21?.toFixed(2),
        adx: adx?.adx?.toFixed(2),
        plusDI: adx?.plusDI?.toFixed(2),
        minusDI: adx?.minusDI?.toFixed(2),
        vix: vixData?.toFixed(2)
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
    console.error('Error in /api/trading-data:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper: Generate mock prices for demo
function generateMockPrices(startPrice, count) {
  const prices = [startPrice];
  for (let i = 1; i < count; i++) {
    const change = (Math.random() - 0.48) * 20; // Slight upward bias
    prices.push(Math.max(prices[i - 1] + change, 19000));
  }
  return prices;
}

// Serve frontend
app.get('/', (req, res) => {
  res.send(getHTMLPage());
});

// HTML Frontend
function getHTMLPage() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NIFTY Live Trader Dashboard</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #0f172a;
            color: #e0e7ff;
            overflow-x: hidden;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 15px;
        }

        header {
            background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%);
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
        }

        h1 {
            font-size: 28px;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .status {
            display: flex;
            gap: 20px;
            font-size: 16px;
            margin-top: 10px;
        }

        .status-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .pulse {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #10b981;
            animation: pulse 2s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .price-display {
            font-size: 32px;
            font-weight: bold;
            color: #fbbf24;
            margin-top: 10px;
        }

        .change {
            font-size: 18px;
        }

        .positive { color: #10b981; }
        .negative { color: #ef4444; }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }

        .card {
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .card h3 {
            color: #60a5fa;
            margin-bottom: 15px;
            font-size: 18px;
            border-bottom: 2px solid #334155;
            padding-bottom: 10px;
        }

        .indicator-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }

        .indicator {
            background: #0f172a;
            padding: 12px;
            border-radius: 6px;
            border-left: 4px solid #60a5fa;
        }

        .indicator-label {
            font-size: 12px;
            color: #94a3b8;
            text-transform: uppercase;
            margin-bottom: 5px;
        }

        .indicator-value {
            font-size: 20px;
            font-weight: bold;
            color: #e0e7ff;
        }

        .trend-badge {
            display: inline-block;
            padding: 8px 16px;
            border-radius: 20px;
            font-weight: bold;
            font-size: 14px;
            text-transform: uppercase;
            margin-top: 10px;
        }

        .uptrend { background: #10b98125; color: #10b981; }
        .downtrend { background: #ef444425; color: #ef4444; }
        .consolidation { background: #f59e0b25; color: #f59e0b; }

        .signal-box {
            background: #0f172a;
            padding: 15px;
            border-radius: 6px;
            margin: 10px 0;
            border-left: 4px solid #fbbf24;
        }

        .signal-type {
            font-weight: bold;
            font-size: 16px;
            color: #fbbf24;
            margin-bottom: 8px;
        }

        .signal-details {
            font-size: 13px;
            color: #cbd5e1;
            line-height: 1.6;
        }

        .chart-container {
            grid-column: 1 / -1;
            background: #1e293b;
            padding: 20px;
            border-radius: 8px;
            border: 1px solid #334155;
        }

        .refresh-button {
            background: #3b82f6;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: bold;
            margin: 10px 0;
        }

        .refresh-button:hover {
            background: #2563eb;
        }

        .loading {
            text-align: center;
            padding: 20px;
            color: #94a3b8;
        }

        @media (max-width: 768px) {
            h1 { font-size: 20px; }
            .price-display { font-size: 24px; }
            .grid {
                grid-template-columns: 1fr;
            }
            .indicator-group {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📈 NIFTY Live Trader Dashboard</h1>
            <div class="status">
                <div class="status-item">
                    <div class="pulse"></div>
                    <span>Live Feed: Angel One SmartAPI</span>
                </div>
                <div class="status-item">
                    <span id="last-update">Loading...</span>
                </div>
            </div>
            <div class="price-display">
                ₹<span id="nifty-price">--</span>
                <span class="change" id="nifty-change">--</span>
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
                document.getElementById('last-update').textContent = 'Fetching...';
                
                const response = await fetch('/api/trading-data');
                const data = await response.json();

                // Update price
                document.getElementById('nifty-price').textContent = data.nifty.price.toFixed(2);
                const changeEl = document.getElementById('nifty-change');
                const changeClass = data.nifty.change >= 0 ? 'positive' : 'negative';
                changeEl.textContent = \`\${data.nifty.change >= 0 ? '+' : ''}\${data.nifty.change.toFixed(2)} (\${data.nifty.changePercent}%)\`;
                changeEl.className = 'change ' + changeClass;

                // Build dashboard
                let html = '';

                // Indicators Card
                html += \`
                    <div class="card">
                        <h3>📊 Technical Indicators</h3>
                        <div class="indicator-group">
                            <div class="indicator">
                                <div class="indicator-label">RSI (14)</div>
                                <div class="indicator-value">\${data.indicators.rsi}</div>
                            </div>
                            <div class="indicator">
                                <div class="indicator-label">ADX (14)</div>
                                <div class="indicator-value">\${data.indicators.adx}</div>
                            </div>
                            <div class="indicator">
                                <div class="indicator-label">EMA 9</div>
                                <div class="indicator-value">\${data.indicators.ema9}</div>
                            </div>
                            <div class="indicator">
                                <div class="indicator-label">EMA 21</div>
                                <div class="indicator-value">\${data.indicators.ema21}</div>
                            </div>
                            <div class="indicator">
                                <div class="indicator-label">+DI</div>
                                <div class="indicator-value">\${data.indicators.plusDI}</div>
                            </div>
                            <div class="indicator">
                                <div class="indicator-label">VIX</div>
                                <div class="indicator-value">\${data.indicators.vix}</div>
                            </div>
                        </div>
                    </div>
                \`;

                // Support & Resistance Card
                html += \`
                    <div class="card">
                        <h3>🎯 Support & Resistance (4H)</h3>
                        <div class="indicator-group">
                            <div class="indicator">
                                <div class="indicator-label">Resistance</div>
                                <div class="indicator-value">₹\${data.supportResistance.resistance}</div>
                            </div>
                            <div class="indicator">
                                <div class="indicator-label">Support</div>
                                <div class="indicator-value">₹\${data.supportResistance.support}</div>
                            </div>
                            <div class="indicator">
                                <div class="indicator-label">Pivot</div>
                                <div class="indicator-value">₹\${data.supportResistance.pivot}</div>
                            </div>
                        </div>
                    </div>
                \`;

                // Trend & 9:20 AM Rule Card
                html += \`
                    <div class="card">
                        <h3>🔄 Market Analysis</h3>
                        <div>
                            <strong>Trend:</strong>
                            <div class="trend-badge \${data.trend.toLowerCase().includes('up') ? 'uptrend' : data.trend.toLowerCase().includes('down') ? 'downtrend' : 'consolidation'}">
                                \${data.trend.replace(/_/g, ' ')}
                            </div>
                        </div>
                        <div style="margin-top: 15px;">
                            <strong>9:20 AM Rule (EMA):</strong>
                            <div class="trend-badge \${data.rule920 === 'BULLISH' ? 'uptrend' : 'downtrend'}" style="margin-top: 8px;">
                                \${data.rule920}
                            </div>
                        </div>
                    </div>
                \`;

                // Trade Signals Card
                html += \`
                    <div class="card">
                        <h3>⚡ Active Trade Signals</h3>
                        \${data.signals.length > 0 ? data.signals.map(signal => \`
                            <div class="signal-box">
                                <div class="signal-type">\${signal.type.replace(/_/g, ' ')}</div>
                                <div class="signal-details">
                                    <strong>Entry:</strong> ₹\${signal.entry.toFixed(2)}<br>
                                    <strong>Target:</strong> ₹\${signal.target.toFixed(2)}<br>
                                    <strong>Stop Loss:</strong> ₹\${signal.stopLoss.toFixed(2)}<br>
                                    <strong>R:R Ratio:</strong> \${signal.riskReward}<br>
                                    <strong>Strength:</strong> \${signal.strength}
                                </div>
                            </div>
                        \`).join('') : '<div style="color: #94a3b8; padding: 15px; text-align: center;">No active signals</div>'}
                    </div>
                \`;

                document.getElementById('dashboard').innerHTML = html;
                document.getElementById('last-update').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
            } catch (error) {
                console.error('Error:', error);
                document.getElementById('dashboard').innerHTML = \`<div class="loading">❌ Error loading data: \${error.message}</div>\`;
            }
        }

        // Auto-refresh every 5 seconds
        setInterval(fetchData, 5000);
        
        // Initial load
        fetchData();
    </script>
</body>
</html>
  `;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`✅ NIFTY Trader Dashboard running on port \${PORT}\`);
  console.log(\`📱 Access at http://localhost:\${PORT}\`);
});
