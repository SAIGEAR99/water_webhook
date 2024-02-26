const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios').default;
const dotenv = require('dotenv');

const app = express();
dotenv.config();

const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET
};

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
    try {
        const events = req.body.events;
        console.log('event>>>', events);

        if (events.length > 0) {
            await Promise.all(events.map(item => handleEvent(item)));
        }
        
        res.status(200).send("OK"); // Always send a 200 OK response
    } catch (error) {
        console.error(error);
        res.status(500).send("Internal Server Error");
    }
});

const handleEvent = async (event) => {
    try {
        console.log(event);
        // Add your event handling logic here
    } catch (error) {
        console.error("Error in handleEvent: ", error);
        // Handle any errors that occur during event handling
    }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
