const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());


app.post('/webhook', async (req, res) => {
    const replyToken = req.body.events[0].replyToken;
    const userMessage = req.body.events[0].message.text.toLowerCase();

    try {
        const sensorData = await getSensorData();
        const responseMessage = createResponseMessage(sensorData, userMessage);
        await sendReply(responseMessage, replyToken);
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Error');
    }
});

async function getSensorData() {
    try {
        const url = 'https://api.sheety.co/4457c48e44b9a655e732354bdcc2bcce/esp32Log/reportPpm';

        const response = await axios.get(url);
        const data = response.data.reportPpm;

        return data.map(row => ({
            tds: row[0],
            temp: row[1],
            humidity: row[2],
            rain: row[3]
        }));
    } catch (error) {
        console.error('Error fetching sensor data:', error);
        throw error;
    }
}


function createResponseMessage(sensorData, userMessage) {
    let message;

    if (userMessage === 'tds') {
        const tds = parseInt(sensorData.tds);
        let notify_wa;

        if (tds < 0 ){
            notify_wa = "❌ ไม่ปกติ";
        } else if(tds >= 1 && tds <= 300){
            notify_wa = "✅ บริสุทธิ์ทั่วไป";
        } else if(tds >= 301 && tds <= 600){
            notify_wa = "🟨 ควรปรับปรุง";
        } else {
            notify_wa = "🟥 คุณภาพแย่";
        }

        // สร้างข้อความที่จะส่งกลับไปยัง LINE
        message = {
            "type": "text",
            "text": `TDS: ${tds} PPM\nสถานะคุณภาพน้ำ: ${notify_wa}`
        };
    } else {
        // สำหรับข้อความอื่นๆ ที่ไม่ใช่ 'tds'
        message = {
            "type": "text",
            "text": "ขอโทษ, ฉันไม่เข้าใจข้อความของคุณ"
        };
    }

    return message;
}

async function sendReply(message, replyToken) {
    const url = 'https://api.line.me/v2/bot/message/reply';
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
    };

    const postData = {
        replyToken,
        messages: [message],
    };

    await axios.post(url, postData, { headers });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
