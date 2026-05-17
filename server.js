require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');

const loginAngel = require('./src/api/angelAuth');
const startWebSocket = require('./src/api/websocket');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;

let marketState = {
    nifty: 0,
    signal: 'WAIT',
    confidence: 0,
    reason: []
};

app.get('/api/signal', (req, res) => {

    res.json(marketState);

});

app.get('/', (req, res) => {

    res.sendFile(__dirname + '/public/index.html');

});

async function initializeLiveData() {

    console.log('Starting VardaanNifty AI...');

    const auth = await loginAngel();

    if(auth){

        console.log('Angel Login Success');

        if(auth.jwtToken){

            startWebSocket(auth.jwtToken);

        }

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
