const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');

const app = express();
dotenv.config();

const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(lineConfig);

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        // Ignore non-text messages
        return Promise.resolve(null);
    }

    // Check if the text message is "สวัสดี"
    if (event.message.text === 'สวัสดี') {
        // Reply with Flex Message
        const flexMessage = {
            type: 'flex',
            altText: 'สวัสดี',
            contents: {
                type: 'bubble',
                body: {
                    type: 'box',
                    layout: 'vertical',
                    contents: [
                        {
                            type: 'text',
                            text: 'สวัสดีครับ/ค่ะ',
                            wrap: true
                        }
                    ]
                }
            }
        };

        return client.replyMessage(event.replyToken, flexMessage);
    } else {
        // Reply with normal text message
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'ขอโทษครับ/ค่ะ ฉันไม่เข้าใจคำถาม'
        });
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
