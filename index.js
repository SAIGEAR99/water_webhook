const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const axios = require('axios');

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

async function fetchLatestData() {
    try {
        const response = await axios.get('https://api.sheety.co/4457c48e44b9a655e732354bdcc2bcce/esp32Log/reportPpm');
        const rows = response.data.reportPpm;
        // สมมติว่าข้อมูลที่ต้องการอยู่ในคอลัมน์ A ของแถวล่าสุด
        const latestData = rows[rows.length - 1].A;
        return latestData;
    } catch (error) {
        console.error('Error fetching data:', error);
        return null;
    }
}

function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    if (event.message.text === 'สวัสดี') {
        // ดึงข้อมูลและส่งกลับในรูปแบบ Flex Message
        return fetchLatestData().then(data => {
            if (data) {
                const flexMessage = {
                    type: 'flex',
                    altText: 'ข้อมูลล่าสุด',
                    contents: {
                        type: 'bubble',
                        body: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [
                                {
                                    type: 'text',
                                    text: `ข้อมูลล่าสุด: ${data}`,
                                    wrap: true
                                }
                            ]
                        }
                    }
                };
                return client.replyMessage(event.replyToken, flexMessage);
            } else {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'ไม่สามารถดึงข้อมูลได้'
                });
            }
        });
    } else {
        // ตอบกลับด้วยข้อความธรรมดา
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
