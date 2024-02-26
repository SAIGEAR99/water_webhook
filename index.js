const express = require('express');
const { Client } = require('@line/bot-sdk');

// กำหนดค่า config สำหรับ LINE Messaging API
const config = {
  channelAccessToken: 'owko9poj+cba20ojGAa2KcGhIB6e44aumaVOoyG/UUAYskltHkiw/XO4z79e13uovw5GYg3fYj57/HGVemzA2CNbW/Ih21yVPK4DUHzFz4ef2sMx0tsTwKSoPfmoTyyftAfAXNXExoRLcpVfBrsLbAdB04t89/1O/w1cDnyilFU=', // ใส่ Access Token ของคุณ
  channelSecret: '05170a024d42b4e13f28b48f76a4bf42', // ใส่ Channel Secret ของคุณ
};

const client = new Client(config);
const app = express();

// สร้าง endpoint สำหรับ webhook
app.post('/webhook', express.json(), (req, res) => {
  req.body.events.forEach(event => {
    if (event.type === 'message' && event.message.type === 'text') {
      // ตรวจสอบข้อความ A และตอบกลับด้วย B
      if (event.message.text === 'A') {
        const replyToken = event.replyToken;
        const message = {
          type: 'text',
          text: 'B',
        };
        client.replyMessage(replyToken, message)
          .then(() => {
            res.status(200).send('OK'); // ส่งสถานะ OK กลับไปยัง LINE
          })
          .catch((err) => {
            console.error(err);
            res.status(500).end();
          });
      } else {
        res.status(200).send('OK'); // ส่งสถานะ OK สำหรับข้อความอื่นๆ
      }
    } else {
      res.status(200).send('OK'); // ส่งสถานะ OK สำหรับเหตุการณ์อื่นๆ
    }
  });
});

// กำหนด port สำหรับเว็บแอป
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
