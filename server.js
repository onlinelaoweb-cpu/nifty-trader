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
