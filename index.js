const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios').default;
const dotenv = require('dotenv');

const app = express();
dotenv.config();

const lineConfig = {
    channelAccessToken: 'hlkg53TDcJ7zW/uCX5GJBYvIZBA06f/u06rmN+KaT29+yM0/fhu9NIISqRnH6Eof+hBVMjTZ0JIGEoFZ9rkjm1paZQwdo7qaZynME81+3ybqoQOmhMralkYAyCYq//QS48t1qzGhbWe9NSBpBOrU6wdB04t89/1O/w1cDnyilFU=',
    channelSecret: '1a3eb4db055d713d1457dfa86f7df5c6'
};

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
    try {
        const events = req.body.events;
        console.log('event>>>', events);
        return events.length > 0 ? await Promise.all(events.map(item => handleEvent(item))) : res.status(200).send("OK");
    } catch (error) {
        console.error(error);
        res.status(500).end();
    }
});

const handleEvent = async (event) => {
    console.log(event);
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
