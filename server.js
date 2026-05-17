require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');

const loginAngel = require('./src/api/angelAuth');
const startWebSocket = require('./src/api/websocket');

const app = express();

const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let marketState = {
    nifty: 0,
    signal: 'WAIT',
    confidence: 0,
    reason: []
};

app.use(express.static('public'));

app.get('/api/signal', (req, res) => {

    res.json(marketState);

});

app.get('/', (req, res) => {

    res.sendFile(__dirname + '/public/index.html');

});

async function initializeLiveData() {

    console.log('Starting VardaanNifty AI...');

    const auth = await loginAngel();

    if(auth?.jwtToken){

        console.log('Angel Login Success');

        startWebSocket(auth.jwtToken);

    }

    else{

        console.log('Angel Login Failed');

    }

}

initializeLiveData();

server.listen(PORT, () => {

    console.log(
        `VardaanNifty AI running on port ${PORT}`
    );

});
