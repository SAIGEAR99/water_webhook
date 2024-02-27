const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const axios = require('axios');
const {google} = require("googleapis");
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const FormData = require('form-data');

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

app.get('/chart-tds-G', async (req, res) => {
    try {
        const data = await fetchLatestDataG();
        const chartBuffer = await createChart(data);
        res.set('Content-Type', 'image/png');
        res.send(chartBuffer);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error in generating chart');
    }
});



async function fetchLatestData() {
  const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });
  
    const client = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: client });
    const spreadsheetId = "1swvSk80vnofeYPkm2yuKt6C09QFrWN6fO3z3RTfwOjg";
    const getRows = await googleSheets.spreadsheets.values.get({
        auth,
        spreadsheetId,
        range: "Report_ppm!A:F",
    });
    if (getRows.data.values && getRows.data.values.length > 0) {
        const latestRow = getRows.data.values[getRows.data.values.length - 1];

        const tds= latestRow[2]; 
        const temp = latestRow[3]; 
        const rain = latestRow[4];
        const humidity = latestRow[5]; 

        return {
          tds, 
          temp, 
          rain, 
          humidity, 
        };
      } else {
        return null;
      }
}
async function fetchLatestDataG() {
    const auth = new google.auth.GoogleAuth({
        keyFile: "credentials.json",
        scopes: "https://www.googleapis.com/auth/spreadsheets",
      });
    
      const client = await auth.getClient();
      const googleSheets = google.sheets({ version: "v4", auth: client });
      const spreadsheetId = "1swvSk80vnofeYPkm2yuKt6C09QFrWN6fO3z3RTfwOjg";
      const getRows = await googleSheets.spreadsheets.values.get({
          auth,
          spreadsheetId,
          range: "Report_ppm!A:F",
      });
    if (getRows.data.values && getRows.data.values.length > 0) {

      const last20Rows = getRows.data.values.slice(-70);
      return last20Rows.map(row => ({
        time: row[1],
        tds: row[2], 
      }));
    } else {
      return null;
    }
  }

async function createChart(data) {
    const width = 800;
    const height = 600;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

    
  
    const configuration = {
      type: 'line',
      data: {
        labels: data.map(item => item.time),
        datasets : [
            {
              label: 'TDS',
              data: data.map(item => item.tds),
              borderColor: '#E53935', // สีแดง
              backgroundColor: 'rgba(229, 57, 53, 0.2)', // สีแดงอ่อน
              fill: true,
              pointRadius: 2, // ขนาดจุด
              pointBackgroundColor: '#E53935', // สีจุด
              borderWidth: 2, // ความหนาเส้น
            },
          ],

      },
    };
  
    return await chartJSNodeCanvas.renderToBuffer(configuration);
}


function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    if (event.message.text === 'latest_status') {
        return fetchLatestData().then(data => {
            const flexMessage = {
                type: 'flex',
                altText: 'ข้อมูลล่าสุด',
                contents: {
                    type: 'bubble',
                    size: 'kilo',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            {
                                "type": "text",
                                "text": "About Sensor",
                                "size": "xl",
                                "weight": "bold"
                              },
                              {
                                "type": "text",
                                "text": "เอกสารที่เกี่ยวข้องและคำอธิบายเซ็นเซอร์",
                                "size": "xxs",
                                "weight": "regular",
                                "color": "#959595"
                              }
                            ]
                    }
                }
            };
            return client.replyMessage(event.replyToken, flexMessage);
        });
    } else if (event.message.text.toLowerCase() === 'sensor') {
        return fetchLatestData().then(data => {
            const flexMessage = {
                type: "flex",
                altText: "Flex Message",
                contents: {
                  type: "bubble",
                  hero: {
                    type: "image",
                    url: "https://www.york.ac.uk/media/study/courses/undergraduate/electronics/Yellow-circuit-EE-crop1200.jpg",
                    size: "full",
                    aspectRatio: "20:13",
                    aspectMode: "cover",
                    action: {
                      type: "uri",
                      uri: "https://linecorp.com"
                    }
                  },
                  body: {
                    type: "box",
                    layout: "vertical",
                    spacing: "none",
                    action: {
                      type: "uri",
                      uri: "https://linecorp.com"
                    },
                    contents: [
                      {
                        type: "text",
                        size: "xxl",
                        weight: "bold",
                        text: "Sensor Module",
                        margin: "none"
                      },
                      {
                        type: "text",
                        size: "xxs",
                        weight: "regular",
                        text: "กรุณาเลือกเซ็นเซอร์ที่ต้องการตรวจสอบ",
                        margin: "none",
                        color: "#868686"
                      }
                    ],
                    margin: "none"
                  },
                  footer: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                      {
                        type: "button",
                        margin: "none",
                        action: {
                          type: "message",
                          label: "TDS Sensor",
                          text: "tds"
                        },
                        position: "relative",
                        height: "md",
                        style: "secondary"
                      },
                      {
                        type: "button",
                        style: "secondary",
                        margin: "lg",
                        action: {
                          type: "message",
                          label: "Temp Sensor",
                          text: "temp"
                        },
                        position: "relative"
                      },
                      {
                        type: "button",
                        style: "secondary",
                        margin: "lg",
                        action: {
                          type: "message",
                          text: "rain",
                          label: "Rain Drop Sensor"
                        },
                        position: "relative"
                      },
                      {
                        type: "button",
                        style: "secondary",
                        margin: "lg",
                        action: {
                          type: "message",
                          label: "Humidity Sensor",
                          text: "humidity"
                        },
                        position: "relative"
                      },
                      {
                        type: "button",
                        style: "primary",
                        margin: "lg",
                        action: {
                          type: "message",
                          label: "All Sensor",
                          text: "all"
                        },
                        position: "relative",
                        color: "#090c25"
                      }
                    ],
                    margin: "none"
                  },
                  size: "kilo"
                }
              };
              
            return client.replyMessage(event.replyToken, flexMessage);
        });
    } 
    else if (event.message.text.toLowerCase() === 'tds') {
        return fetchLatestData().then(async data => {

            if (data.tds < 0 ){
                var notify_wa = "❌ ไม่ปกติ"
              }else if(data.tds >= 1 && data.tds <= 300){
                var notify_wa = "✅ บริสุทธิ์ทั่วไป"
              }else if(data.tds >= 301 && data.tds <= 600){
                var notify_wa = "🟨 ควรปรับปรุง"
              }else{
                var notify_wa = "🟥 คุณภาพแย่"
              }
              const header_url = "https://water-bot-222609226e9c.herokuapp.com";
              const flexMessage = {
                "type": "flex",
                "altText": "Flex Message",
                "contents": {
                  "type": "bubble",
                  "size": "giga",
                  "hero": {
                    "type": "image",
                    "url": header_url+"/chart-tds-G",
                    "size": "full",
                    "aspectRatio": "8:6",
                    "aspectMode": "cover",
                    "action": {
                      "type": "uri",
                      "uri": header_url+"/chart-tds-G"
                    }
                  },
                  "body": {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [
                      {
                        "type": "text",
                        "text": "TDS Sensor",
                        "weight": "bold",
                        "size": "xxl",
                        "margin": "none"
                      },
                      {
                        "type": "box",
                        "layout": "vertical",
                        "margin": "lg",
                        "spacing": "none",
                        "contents": [
                          {
                            "type": "box",
                            "layout": "baseline",
                            "spacing": "sm",
                            "contents": [
                              {
                                "type": "text",
                                "text": "(1) ปริมาณสารละลาย",
                                "size": "md",
                                "flex": 5,
                                "margin": "none"
                              },
                              {
                                "type": "text",
                                "text": data.tds + " PPM",
                                "wrap": true,
                                "color": "#666666",
                                "size": "md",
                                "flex": 5,
                                "align": "end",
                                "margin": "none"
                              }
                            ],
                            "margin": "none"
                          },
                          {
                            "type": "box",
                            "layout": "baseline",
                            "spacing": "sm",
                            "contents": [
                              {
                                "type": "text",
                                "text": "(2) สถานะคุณภาพน้ำ",
                                "size": "md",
                                "flex": 5,
                                "margin": "none"
                              },
                              {
                                "type": "text",
                                "text": notify_wa,
                                "wrap": true,
                                "color": "#666666",
                                "size": "md",
                                "flex": 5,
                                "align": "end",
                                "margin": "none"
                              }
                            ],
                            "margin": "none"
                          }
                        ]
                      }
                    ]
                  }
                }
              };
              
              
            return client.replyMessage(event.replyToken, flexMessage);
        });
    }  else if (event.message.text.toLowerCase() === 'temp') {
        return fetchLatestData().then(data => {
            const flexMessage = {
                type: 'flex',
                altText: 'ข้อมูลล่าสุด',
                contents: {
                    type: 'bubble',
                    size: 'kilo',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            {
                                "type": "text",
                                "text": "About Sensor",
                                "size": "xl",
                                "weight": "bold"
                              },
                              {
                                "type": "text",
                                "text": "เอกสารที่เกี่ยวข้องและคำอธิบายเซ็นเซอร์2",
                                "size": "xxs",
                                "weight": "regular",
                                "color": "#959595"
                              }
                            ]
                    }
                }
            };
            return client.replyMessage(event.replyToken, flexMessage);
        });
    } 
    else if (event.message.text.toLowerCase() === 'rain') {
        return fetchLatestData().then(data => {
            const flexMessage = {
                type: 'flex',
                altText: 'ข้อมูลล่าสุด',
                contents: {
                    type: 'bubble',
                    size: 'kilo',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            {
                                "type": "text",
                                "text": "About Sensor",
                                "size": "xl",
                                "weight": "bold"
                              },
                              {
                                "type": "text",
                                "text": "เอกสารที่เกี่ยวข้องและคำอธิบายเซ็นเซอร์2",
                                "size": "xxs",
                                "weight": "regular",
                                "color": "#959595"
                              }
                            ]
                    }
                }
            };
            return client.replyMessage(event.replyToken, flexMessage);
        });
    }
    else if (event.message.text.toLowerCase() === 'humidity') {
        return fetchLatestData().then(data => {
            const flexMessage = {
                type: 'flex',
                altText: 'ข้อมูลล่าสุด',
                contents: {
                    type: 'bubble',
                    size: 'kilo',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            {
                                "type": "text",
                                "text": "About Sensor",
                                "size": "xl",
                                "weight": "bold"
                              },
                              {
                                "type": "text",
                                "text": "เอกสารที่เกี่ยวข้องและคำอธิบายเซ็นเซอร์2",
                                "size": "xxs",
                                "weight": "regular",
                                "color": "#959595"
                              }
                            ]
                    }
                }
            };
            return client.replyMessage(event.replyToken, flexMessage);
        });
    }  
    else if (event.message.text.toLowerCase() === 'all') {
        return fetchLatestData().then(data => {
            const flexMessage = {
                type: 'flex',
                altText: 'ข้อมูลล่าสุด',
                contents: {
                    type: 'bubble',
                    size: 'kilo',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            {
                                "type": "text",
                                "text": "About Sensor",
                                "size": "xl",
                                "weight": "bold"
                              },
                              {
                                "type": "text",
                                "text": "เอกสารที่เกี่ยวข้องและคำอธิบายเซ็นเซอร์2",
                                "size": "xxs",
                                "weight": "regular",
                                "color": "#959595"
                              }
                            ]
                    }
                }
            };
            return client.replyMessage(event.replyToken, flexMessage);
        });
    } 
    else {
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
