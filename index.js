const express = require('express');
const line = require('@line/bot-sdk');
const dotenv = require('dotenv');
const axios = require('axios');
const {google} = require("googleapis");
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const FormData = require('form-data');
const mqtt = require('mqtt');
const fs = require('fs');
const tf = require('@tensorflow/tfjs');
const path = require('path');
const caFile = fs.readFileSync('emqxsl-ca.crt');
const ejs = require('ejs');
const { Server } = require('ws');
const mqttClient = require('./mqtt');
const header_url = "https://water-bot-222609226e9c.herokuapp.com";


//ส่วนหัว
const MQTT_TOPIC_HUMIDITY = '/topic/humidity';
const MQTT_TOPIC_TEMP = '/topic/temp';
const MQTT_TOPIC_TDS = '/topic/tds';
const MQTT_TOPIC_TEMP_AIR = '/topic/temp_air';
const MQTT_TOPIC_RAIN = '/topic/rain';
const MQTT_TOPIC_LIGHT = '/topic/light';

// Subscribe to both topics
mqttClient.subscribe(MQTT_TOPIC_HUMIDITY);
mqttClient.subscribe(MQTT_TOPIC_TEMP);
mqttClient.subscribe(MQTT_TOPIC_TDS);
mqttClient.subscribe(MQTT_TOPIC_TEMP_AIR);
mqttClient.subscribe(MQTT_TOPIC_RAIN);
mqttClient.subscribe(MQTT_TOPIC_LIGHT);


//กำหนดค่า Global ของค่าที่รับมาจาก MQTT
let latestHumidity = null;
let latestTemperature = null;
let latestTds = null;
let latestTemp_air = null;
let latestRain = null;
let latestLight = null;

const app = express();
dotenv.config();

const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET
};


const client = new line.Client(lineConfig);


//เส้นทาง UI หน้าเว็บแสดงเซ็นเซอร์
const graphRoute = require('./graph');
app.use('/graph',graphRoute);

app.set('views',__dirname + '/views')
app.set('view engine','ejs');
app.engine('ejs',ejs.renderFile);

app.use('/static', express.static(path.join(__dirname, 'views')));


app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});





async function loadAndTrainModel(soilHumidity, rain, lightIntensity, airTemp) {

  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: "https://www.googleapis.com/auth/spreadsheets",
  });

  const client = await auth.getClient();
  const googleSheets = google.sheets({ version: "v4", auth: client });
  const spreadsheetId = "1swvSk80vnofeYPkm2yuKt6C09QFrWN6fO3z3RTfwOjg";
  const response = await googleSheets.spreadsheets.values.get({
      auth,
      spreadsheetId,
      range: "Report_ppm!A:L",
  });

  let data = response.data.values;
  data.shift();

  const inputs = data.map(d => [+d[4], +d[5], +d[7], +d[8]]); // Columns E, F, H, I
  const labels = data.map(d => [+d[9]]);


  const inputsNormalized = inputs.map(d => [d[0] / 100, d[1] / 100, d[2] / 100, d[3] / 100]);
  const labelsNormalized = labels.map(d => [d[0] / 50]);

  const inputTensor = tf.tensor2d(inputsNormalized, [inputs.length, 4]); 
  const labelTensor = tf.tensor2d(labelsNormalized, [labels.length, 1]);


  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 10, inputShape: [4] }));
  model.add(tf.layers.dense({ units: 1 }));
  model.compile({ loss: 'meanSquaredError', optimizer: 'sgd' });

  model.compile({ loss: 'meanSquaredError', optimizer: 'sgd' });

  await model.fit(inputTensor, labelTensor, { epochs: 500 });


  const req_data = [
    denormalize_input(soilHumidity, 100), 
    denormalize_input(rain, 100),
    denormalize_input(lightIntensity, 100),
    denormalize_input(airTemp, 100)
  ];
  const prediction = model.predict(tf.tensor2d([req_data]));

  const predictionValues = prediction.dataSync();
  const denormalizedValues = Array.from(predictionValues).map(value => denormalize(value, 100));
  console.log("Predicted pump duration: ", denormalizedValues);
  const ai_value = denormalizedValues.map(value => value.toFixed(2));

  return { ai_value };
}


function denormalize(value, max) {
  return value * max;
}
function denormalize_input(value, max) {
  return value / max;
}

//----------------------------------------จบ AI ---------------------------------//




//------------------------เริ่มการสั่งปั๊มน้ำด้วย Ai--------------------------//
async function checkAndActivatePump() {

  const humidity = latestHumidity;
  const rain = latestRain;
  const temp_air = latestTemp_air;
  const light = latestLight;

  console.log('------------> humidity ',humidity);
  console.log('------------> rain ',rain);
  console.log('------------> temp_air',temp_air);
  console.log('------------> light',light);

  if (humidity < 70) {
    const prediction = await loadAndTrainModel(humidity, rain, light,temp_air,);
    const pumpDuration = prediction.ai_value;

    activatePumpForDuration(pumpDuration);
  }else
  console.log('-------->ไม่ทำ')
}

setInterval(checkAndActivatePump, 120000);


function activatePumpForDuration(duration) {
  
  mqttClient.publish('/topic/qos0', 'on_pump_'+`${duration}`+'.0', { qos: 0 }, (error) => {
    console.log('------------> activatePumpForDuration ',duration);
    if (error) {
        console.error('Error Publishing: ', error);
    }

  });

}
//------------------------จบการสั่งปั๊มน้ำด้วย Ai--------------------------//









//------------------------แสดงกราฟของเซ็นเซอร์--------------------------//
app.get('/chart-tds', async (req, res) => {

    try {
        const data = await fetchLatestData_tds();
        const chartBuffer = await createChart_tds(data);
        res.set('Content-Type', 'image/png');
        res.send(chartBuffer);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error in generating chart');
    }
});

app.get('/chart-temp', async (req, res) => {


  try {
      const data = await fetchLatestData_temp();
      const chartBuffer = await createChart_temp(data);
      res.set('Content-Type', 'image/png');
      res.send(chartBuffer);
  } catch (error) {
      console.error(error);
      res.status(500).send('Error in generating chart');
  }
});

app.get('/chart-rain', async (req, res) => {


  try {
      const data = await fetchLatestData_rain();
      const chartBuffer = await createChart_rain(data);
      res.set('Content-Type', 'image/png');
      res.send(chartBuffer);
  } catch (error) {
      console.error(error);
      res.status(500).send('Error in generating chart');
  }
});

app.get('/chart-humidity', async (req, res) => {


  try {
      const data = await fetchLatestData_humidity();
      const chartBuffer = await createChart_humidity(data);
      res.set('Content-Type', 'image/png');
      res.send(chartBuffer);
  } catch (error) {
      console.error(error);
      res.status(500).send('Error in generating chart');
  }
});

app.get('/chart-temp_air', async (req, res) => {


  try {
      const data = await fetchLatestData_temp_air();
      const chartBuffer = await createChart_temp_air(data);
      res.set('Content-Type', 'image/png');
      res.send(chartBuffer);
  } catch (error) {
      console.error(error);
      res.status(500).send('Error in generating chart');
  }
});

app.get('/chart-light', async (req, res) => {


  try {
      const data = await fetchLatestData_light();
      const chartBuffer = await createChart_light(data);
      res.set('Content-Type', 'image/png');
      res.send(chartBuffer);
  } catch (error) {
      console.error(error);
      res.status(500).send('Error in generating chart');
  }
});

//------------------------จบแสดงกราฟของเซ็นเซอร์--------------------------//




//------------------------ดึงค่าของเซ็นเซอร์จาก Google sheet API--------------------------//

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
        range: "Report_ppm!A:J",
    });
    if (getRows.data.values && getRows.data.values.length > 0) {
        const latestRow = getRows.data.values[getRows.data.values.length - 1];

        const tds= latestRow[2]; 
        const temp = latestRow[3]; 
        const rain = latestRow[5];
        const humidity = latestRow[4];
        const data_fecth = latestRow[6];
        const light = latestRow[7];
        const temp_air = latestRow[8];
        const rows = getRows.data.values.length;

        return {
          tds, 
          temp, 
          rain, 
          humidity,
          rows,
          data_fecth,
          light,
          temp_air
        };
      } else {
        return null;
      }
}
async function fetchLatestData_tds() {
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

      const last20Rows = getRows.data.values.slice(-100);
      return last20Rows.map(row => ({
        time: row[1],
        tds: row[2], 
      }));
    } else {
      return null;
    }
  }

  async function fetchLatestData_temp() {
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

      const last20Rows = getRows.data.values.slice(-100);
      return last20Rows.map(row => ({
        time: row[1],
        tds: row[3], 
      }));
    } else {
      return null;
    }
  }

  async function fetchLatestData_rain() {
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

      const last20Rows = getRows.data.values.slice(-100);
      return last20Rows.map(row => ({
        time: row[1],
        tds: row[5], 
      }));
    } else {
      return null;
    }
  }

  async function fetchLatestData_humidity() {
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

      const last20Rows = getRows.data.values.slice(-400);
      return last20Rows.map(row => ({
        time: row[1],
        tds: row[4], 
      }));
    } else {
      return null;
    }
  }
  async function fetchLatestData_temp_air() {
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
          range: "Report_ppm!A:L",
      });
    if (getRows.data.values && getRows.data.values.length > 0) {

      const last20Rows = getRows.data.values.slice(-400);
      return last20Rows.map(row => ({
        time: row[1],
        tds: row[8], 
      }));
    } else {
      return null;
    }
  }
  async function fetchLatestData_light() {
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
          range: "Report_ppm!A:L",
      });
    if (getRows.data.values && getRows.data.values.length > 0) {

      const last20Rows = getRows.data.values.slice(-400);
      return last20Rows.map(row => ({
        time: row[1],
        tds: row[7], 
      }));
    } else {
      return null;
    }
  }


async function fetchLatestData_average(messageText) {

  const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets",
  });

  const client = await auth.getClient();
  const googleSheets = google.sheets({ version: "v4", auth: client });
  const spreadsheetId = "1swvSk80vnofeYPkm2yuKt6C09QFrWN6fO3z3RTfwOjg";

  try {
      const getRows = await googleSheets.spreadsheets.values.get({
          auth,
          spreadsheetId,
          range: "Report_ppm!A:L",
      });

      if (getRows.data.values && getRows.data.values.length > 0) {
          const value = messageText;
          console.log('----------------->>>',value);
          const lastRows = getRows.data.values.slice(-value);

          const percentile = (arr, p) => {
              const sorted = arr.slice().sort((a, b) => a - b);
              const pos = (sorted.length - 1) * p / 100;
              const base = Math.floor(pos);
              const rest = pos - base;
              if (sorted[base + 1] !== undefined) {
                  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
              } else {
                  return sorted[base];
              }
          };

          const median = (arr) => {
              const mid = Math.floor(arr.length / 2);
              const nums = [...arr].sort((a, b) => a - b);
              return arr.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
          };
          const mode = (arr) => {
              const freqMap = {};
              let maxFreq = 0;
              let mode;
              for (const item of arr) {
                  if (freqMap[item]) {
                      freqMap[item]++;
                  } else {
                      freqMap[item] = 1;
                  }

                  if (freqMap[item] > maxFreq) {
                      maxFreq = freqMap[item];
                      mode = item;
                  }
              }
              return mode;
          };

          const calculateMetricsForSensor = (columnIndex) => {
              const values = lastRows.map(row => parseFloat(row[columnIndex])).filter(n => !isNaN(n));
              const average = values.reduce((a, b) => a + b, 0) / values.length;
              const max = Math.max(...values);
              const min = Math.min(...values);
              const stdDev = Math.sqrt(values.map(x => Math.pow(x - average, 2)).reduce((a, b) => a + b) / values.length);
              const percentile25 = percentile(values, 25);
              const percentile50 = percentile(values, 50);
              const percentile75 = percentile(values, 75);
              const med = median(values);
              const mod = mode(values);
      
              return { average, max, min, stdDev, percentile25, percentile50, percentile75, median: med, mode: mod };
          };
  
          const sensorData = {
              tds: calculateMetricsForSensor(2),
              temp: calculateMetricsForSensor(3),
              humidity: calculateMetricsForSensor(4),
              rain: calculateMetricsForSensor(5),
              temp_air: calculateMetricsForSensor(8),
              light: calculateMetricsForSensor(7),
          };

          console.log(sensorData);
          return sensorData;
      } else {
          return null;
      }
  } catch (error) {
      console.error(error.message);
  }
}
//------------------------จบดึงค่าของเซ็นเซอร์จาก Google sheet API--------------------------//







//------------------------เริ่มสร้างกราฟของเซ็นเซฮร์ด้วย ChartJs--------------------------//

async function createChart_tds(data) {
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
              borderColor: '#0066FF', 
              backgroundColor: 'rgba(173, 216, 230, 0.2)', 
              fill: true,
              pointRadius: 2, 
              pointBackgroundColor: '#0066FF', 
              borderWidth: 2, 
            },
          ],

      },
    };
  
    return await chartJSNodeCanvas.renderToBuffer(configuration);
}

async function createChart_temp(data) {
  const width = 800;
  const height = 600;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

  const configuration = {
    type: 'line',
    data: {
      labels: data.map(item => item.time),
      datasets : [
          {
            label: 'Temp',
            data: data.map(item => item.tds),
            borderColor: '#E53935', 
            backgroundColor: 'rgba(229, 57, 53, 0.2)', 
            fill: true,
            pointRadius: 2,
            pointBackgroundColor: '#E53935', 
            borderWidth: 2, 
          },
        ],

    },
  };

  return await chartJSNodeCanvas.renderToBuffer(configuration);
}

async function createChart_rain(data) {
  const width = 800;
  const height = 600;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

  const configuration = {
    type: 'line',
    data: {
      labels: data.map(item => item.time),
      datasets : [
          {
            label: 'Rain Drop',
            data: data.map(item => item.tds),
            borderColor: '#006600',
            backgroundColor: 'rgba(144, 238, 144, 0.2)', 
            fill: true,
            pointRadius: 2, 
            pointBackgroundColor: '#006600', 
            borderWidth: 2, 
          },
        ],

    },
  };

  return await chartJSNodeCanvas.renderToBuffer(configuration);
}

async function createChart_humidity(data) {
  const width = 800;
  const height = 600;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

  const configuration = {
    type: 'line',
    data: {
      labels: data.map(item => item.time),
      datasets : [
          {
            label: 'Humidity',
            data: data.map(item => item.tds),
            borderColor: '#000000', 
            backgroundColor: 'rgba(50, 50, 50, 0.2)', 
            fill: true,
            pointRadius: 2, 
            pointBackgroundColor: '#000000', 
            borderWidth: 2, 
          },
        ],

    },
  };

  return await chartJSNodeCanvas.renderToBuffer(configuration);
}

async function createChart_temp_air(data) {
  const width = 800;
  const height = 600;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

  const configuration = {
    type: 'line',
    data: {
      labels: data.map(item => item.time),
      datasets : [
          {
            label: 'Temp Air',
            data: data.map(item => item.tds),
            borderColor: '#800080', 
            backgroundColor: 'rgba(128, 0, 128, 0.2)', 
            fill: true,
            pointRadius: 2, 
            pointBackgroundColor: '#800080', 
            borderWidth: 2, 
          },
        ],

    },
  };

  return await chartJSNodeCanvas.renderToBuffer(configuration);
}

async function createChart_light(data) {
  const width = 800;
  const height = 600;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

  const configuration = {
    type: 'line',
    data: {
      labels: data.map(item => item.time),
      datasets : [
          {
            label: 'Light',
            data: data.map(item => item.tds),
            borderColor: '#FFA500', 
            backgroundColor: 'rgba(255, 165, 0, 0.2)', 
            fill: true,
            pointRadius: 2, 
            pointBackgroundColor: '#FFA500',
            borderWidth: 2, 
          },
        ],

    },
  };

  return await chartJSNodeCanvas.renderToBuffer(configuration);
}






//------------------------จบสร้างกราฟของเซ็นเซฮร์ด้วย ChartJs--------------------------//










//------------------------เริ่มส่วนติดต่อกับ Line OA ทั้งหมด Res,Req--------------------------//
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const text = event.message.text.toLowerCase();
    const match_tds = text.match(/^tds(.+)/);
    const match_temp = text.match(/^temp(.+)/);         
    const match_rain = text.match(/^rain(.+)/);
    const match_air = text.match(/^air(.+)/);
    const match_light = text.match(/^light(.+)/);
    const match_humidity = text.match(/^humidity(.+)/);
    const match_time = text.match(/^time(.+)/);
    const match_pump = text.match(/^pump(.+)/);
    const match_set_data = text.match(/set(.+)/);
    const match_ai = text.match(/ai_(\d+)_(\d+)_(\d+)/);

    if (match_ai) {
      const humidity = parseInt(match_ai[1], 10);
      const rain = parseInt(match_ai[2], 10);
      const temp = parseInt(match_ai[3], 10);
      return loadAndTrainModel(humidity,rain,temp).then(data => {
        const flexMessage = {
          "type": "flex",
          "altText": "Flex Message",
          "contents": {
            "type": "bubble",
            "size": "kilo",
            "body": {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": "AI: "+`${data.ai_value}`,
                  "weight": "bold",
                  "size": "xl"
                },
              ]
            },
            "footer": {
              "type": "box",
              "layout": "vertical",
              "spacing": "md",
              "contents": [
                {
                  "type": "box",
                  "layout": "vertical",
                  "contents": [],
                  "margin": "sm"
                }
              ],
              "flex": 0
            }
          }
        };
        
          return client.replyMessage(event.replyToken, flexMessage);
      });

    }
    if (match_tds) {
      const valueAfterAvgTds = match_tds[1];
      return fetchLatestData_average(valueAfterAvgTds).then(data => {
        const flexMessage = {
          type: "flex",
          altText: "Flex Message",
          contents: {
            type: "bubble",
            size: "kilo",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "ค่าสถิติ (TDS)",
                  weight: "bold",
                  size: "xl",
                  margin: "md"
                },
                {
                  type: "text",
                  text: "ผลคำนวณทางสถิติย้อนหลัง ~" + `${valueAfterAvgTds}`,
                  size: "xs",
                  color: "#aaaaaa",
                  wrap: true
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "vertical",
                  margin: "xxl",
                  spacing: "sm",
                  contents: [
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Average",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.tds.average.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          size: "sm",
                          color: "#555555",
                          flex: 0,
                          text: "Median"
                        },
                        {
                          type: "text",
                          text: `${data.tds.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Mode",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.tds.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      margin: "xxl",
                      contents: [
                        {
                          type: "text",
                          text: "Max. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.tds.max.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Min. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.tds.min.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Std. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.tds.stdDev.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 25",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.tds.percentile25}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 50",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.tds.percentile50}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 75",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.tds.percentile75}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "horizontal",
                  margin: "md",
                  contents: [
                    {
                      type: "text",
                      text: "REPORT ID",
                      size: "xs",
                      color: "#aaaaaa",
                      flex: 0
                    },
                    {
                      type: "text",
                      text: "#743289384279"+`${data.tds.average}`,
                      color: "#aaaaaa",
                      size: "xs",
                      align: "end"
                    }
                  ]
                }
              ]
            },
            styles: {
              footer: {
                separator: true
              }
            }
          }
        };
        
          return client.replyMessage(event.replyToken, flexMessage);
      });

    }
    if (match_temp) {
      const valueAfterAvgTds = match_temp[1];
      return fetchLatestData_average(valueAfterAvgTds).then(data => {
        const flexMessage = {
          type: "flex",
          altText: "Flex Message",
          contents: {
            type: "bubble",
            size: "kilo",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "ค่าสถิติ (Temp)",
                  weight: "bold",
                  size: "xl",
                  margin: "md"
                },
                {
                  type: "text",
                  text: "ผลคำนวณทางสถิติย้อนหลัง ~" + `${valueAfterAvgTds}`,
                  size: "xs",
                  color: "#aaaaaa",
                  wrap: true
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "vertical",
                  margin: "xxl",
                  spacing: "sm",
                  contents: [
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Average",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.temp.average.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          size: "sm",
                          color: "#555555",
                          flex: 0,
                          text: "Median"
                        },
                        {
                          type: "text",
                          text: `${data.temp.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Mode",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.temp.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      margin: "xxl",
                      contents: [
                        {
                          type: "text",
                          text: "Max. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp.max.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Min. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp.min.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Std. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp.stdDev.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 25",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp.percentile25}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 50",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp.percentile50}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 75",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp.percentile75}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "horizontal",
                  margin: "md",
                  contents: [
                    {
                      type: "text",
                      text: "REPORT ID",
                      size: "xs",
                      color: "#aaaaaa",
                      flex: 0
                    },
                    {
                      type: "text",
                      text: "#743289384279"+`${data.temp.average}`,
                      color: "#aaaaaa",
                      size: "xs",
                      align: "end"
                    }
                  ]
                }
              ]
            },
            styles: {
              footer: {
                separator: true
              }
            }
          }
        };
        
          return client.replyMessage(event.replyToken, flexMessage);
      });

    }
    if (match_rain) {
      const valueAfterAvgTds = match_rain[1];
      return fetchLatestData_average(valueAfterAvgTds).then(data => {
        const flexMessage = {
          type: "flex",
          altText: "Flex Message",
          contents: {
            type: "bubble",
            size: "kilo",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "ค่าสถิติ (Rain Drop)",
                  weight: "bold",
                  size: "xl",
                  margin: "md"
                },
                {
                  type: "text",
                  text: "ผลคำนวณทางสถิติย้อนหลัง ~" + `${valueAfterAvgTds}`,
                  size: "xs",
                  color: "#aaaaaa",
                  wrap: true
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "vertical",
                  margin: "xxl",
                  spacing: "sm",
                  contents: [
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Average",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.rain.average.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          size: "sm",
                          color: "#555555",
                          flex: 0,
                          text: "Median"
                        },
                        {
                          type: "text",
                          text: `${data.rain.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Mode",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.rain.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      margin: "xxl",
                      contents: [
                        {
                          type: "text",
                          text: "Max. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.rain.max.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Min. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.rain.min.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Std. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.rain.stdDev.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 25",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.rain.percentile25}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 50",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.rain.percentile50}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 75",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.rain.percentile75}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "horizontal",
                  margin: "md",
                  contents: [
                    {
                      type: "text",
                      text: "REPORT ID",
                      size: "xs",
                      color: "#aaaaaa",
                      flex: 0
                    },
                    {
                      type: "text",
                      text: "#743289384279"+`${data.rain.average}`,
                      color: "#aaaaaa",
                      size: "xs",
                      align: "end"
                    }
                  ]
                }
              ]
            },
            styles: {
              footer: {
                separator: true
              }
            }
          }
        };
        
          return client.replyMessage(event.replyToken, flexMessage);
      });

    }

    if (match_humidity) {
      const valueAfterAvgTds = match_humidity[1];
      return fetchLatestData_average(valueAfterAvgTds).then(data => {
        const flexMessage = {
          type: "flex",
          altText: "Flex Message",
          contents: {
            type: "bubble",
            size: "kilo",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "ค่าสถิติ (Humidity)",
                  weight: "bold",
                  size: "xl",
                  margin: "md"
                },
                {
                  type: "text",
                  text: "ผลคำนวณทางสถิติย้อนหลัง ~" + `${valueAfterAvgTds}`,
                  size: "xs",
                  color: "#aaaaaa",
                  wrap: true
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "vertical",
                  margin: "xxl",
                  spacing: "sm",
                  contents: [
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Average",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.humidity.average.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          size: "sm",
                          color: "#555555",
                          flex: 0,
                          text: "Median"
                        },
                        {
                          type: "text",
                          text: `${data.humidity.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Mode",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.humidity.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      margin: "xxl",
                      contents: [
                        {
                          type: "text",
                          text: "Max. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.humidity.max.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Min. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.humidity.min.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Std. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.humidity.stdDev.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 25",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.humidity.percentile25}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 50",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.humidity.percentile50}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 75",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.humidity.percentile75}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "horizontal",
                  margin: "md",
                  contents: [
                    {
                      type: "text",
                      text: "REPORT ID",
                      size: "xs",
                      color: "#aaaaaa",
                      flex: 0
                    },
                    {
                      type: "text",
                      text: "#743289384279"+`${data.humidity.average}`,
                      color: "#aaaaaa",
                      size: "xs",
                      align: "end"
                    }
                  ]
                }
              ]
            },
            styles: {
              footer: {
                separator: true
              }
            }
          }
        };
        
          return client.replyMessage(event.replyToken, flexMessage);
      });

    }
    if (match_air) {
      const valueAfterAvgTds = match_air[1];
      return fetchLatestData_average(valueAfterAvgTds).then(data => {
        const flexMessage = {
          type: "flex",
          altText: "Flex Message",
          contents: {
            type: "bubble",
            size: "kilo",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "ค่าสถิติ (Temp Air)",
                  weight: "bold",
                  size: "xl",
                  margin: "md"
                },
                {
                  type: "text",
                  text: "ผลคำนวณทางสถิติย้อนหลัง ~" + `${valueAfterAvgTds}`,
                  size: "xs",
                  color: "#aaaaaa",
                  wrap: true
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "vertical",
                  margin: "xxl",
                  spacing: "sm",
                  contents: [
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Average",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.average.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          size: "sm",
                          color: "#555555",
                          flex: 0,
                          text: "Median"
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Mode",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      margin: "xxl",
                      contents: [
                        {
                          type: "text",
                          text: "Max. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.max.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Min. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.min.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Std. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.stdDev.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 25",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.percentile25}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 50",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.percentile50}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 75",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.temp_air.percentile75}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "horizontal",
                  margin: "md",
                  contents: [
                    {
                      type: "text",
                      text: "REPORT ID",
                      size: "xs",
                      color: "#aaaaaa",
                      flex: 0
                    },
                    {
                      type: "text",
                      text: "#743289384279"+`${data.temp_air.average}`,
                      color: "#aaaaaa",
                      size: "xs",
                      align: "end"
                    }
                  ]
                }
              ]
            },
            styles: {
              footer: {
                separator: true
              }
            }
          }
        };
        
          return client.replyMessage(event.replyToken, flexMessage);
      });

    }
    if (match_light) {
      const valueAfterAvgTds = match_light[1];
      return fetchLatestData_average(valueAfterAvgTds).then(data => {
        const flexMessage = {
          type: "flex",
          altText: "Flex Message",
          contents: {
            type: "bubble",
            size: "kilo",
            body: {
              type: "box",
              layout: "vertical",
              contents: [
                {
                  type: "text",
                  text: "ค่าสถิติ (Light)",
                  weight: "bold",
                  size: "xl",
                  margin: "md"
                },
                {
                  type: "text",
                  text: "ผลคำนวณทางสถิติย้อนหลัง ~" + `${valueAfterAvgTds}`,
                  size: "xs",
                  color: "#aaaaaa",
                  wrap: true
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "vertical",
                  margin: "xxl",
                  spacing: "sm",
                  contents: [
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Average",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.light.average.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          size: "sm",
                          color: "#555555",
                          flex: 0,
                          text: "Median"
                        },
                        {
                          type: "text",
                          text: `${data.light.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Mode",
                          size: "sm",
                          color: "#555555",
                          flex: 0
                        },
                        {
                          type: "text",
                          text: `${data.light.median.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      margin: "xxl",
                      contents: [
                        {
                          type: "text",
                          text: "Max. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.light.max.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Min. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.light.min.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Std. value",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.light.stdDev.toFixed(2)}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 25",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.light.percentile25}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 50",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.light.percentile50}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    },
                    {
                      type: "box",
                      layout: "horizontal",
                      contents: [
                        {
                          type: "text",
                          text: "Percentile 75",
                          size: "sm",
                          color: "#555555"
                        },
                        {
                          type: "text",
                          text: `${data.light.percentile75}`,
                          size: "sm",
                          color: "#111111",
                          align: "end"
                        }
                      ]
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  type: "box",
                  layout: "horizontal",
                  margin: "md",
                  contents: [
                    {
                      type: "text",
                      text: "REPORT ID",
                      size: "xs",
                      color: "#aaaaaa",
                      flex: 0
                    },
                    {
                      type: "text",
                      text: "#743289384279"+`${data.light.average}`,
                      color: "#aaaaaa",
                      size: "xs",
                      align: "end"
                    }
                  ]
                }
              ]
            },
            styles: {
              footer: {
                separator: true
              }
            }
          }
        };
        
          return client.replyMessage(event.replyToken, flexMessage);
      });

    }

    if (event.message.text === 'latest_status') {
        return fetchLatestData().then(data => {

          const flexMessage = {
            type: "flex",
            altText: "Flex Message",
            contents: {
                type: "bubble",
                size: "kilo",
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        {
                            type: "text",
                            text: "📈 Status",
                            weight: "bold",
                            size: "xxl",
                            margin: "none"
                        },
                        {
                            type: "separator",
                            margin: "xxl"
                        },
                        {
                            type: "box",
                            layout: "vertical",
                            margin: "xxl",
                            spacing: "sm",
                            contents: [
                                {
                                    type: "box",
                                    layout: "horizontal",
                                    contents: [
                                        {
                                            type: "text",
                                            text: "TDS Sensor",
                                            size: "md",
                                            color: "#555555",
                                            flex: 0,
                                            weight: "bold"
                                        }
                                    ]
                                },
                                {
                                    type: "box",
                                    layout: "horizontal",
                                    contents: [
                                        {
                                            type: "text",
                                            text: "▪ ปริมาณสารละลาย",
                                            size: "sm",
                                            color: "#555555",
                                            flex: 0
                                        },
                                        {
                                            type: "text",
                                            text: data.tds+ " PPM",
                                            size: "sm",
                                            color: "#111111",
                                            align: "end"
                                        }
                                    ]
                                },
                                {
                                    type: "separator",
                                    margin: "xxl"
                                },
                                {
                                    type: "box",
                                    layout: "horizontal",
                                    margin: "xxl",
                                    contents: [
                                        {
                                            type: "text",
                                            text: "Temp Sensor",
                                            size: "md",
                                            color: "#555555",
                                            weight: "bold"
                                        }
                                    ]
                                },
                                {
                                    type: "box",
                                    layout: "horizontal",
                                    contents: [
                                        {
                                            type: "text",
                                            text: "▪ อุณหภูมิน้ำ",
                                            size: "sm",
                                            color: "#555555"
                                        },
                                        {
                                            type: "text",
                                            text: data.temp + " °C",
                                            size: "sm",
                                            color: "#111111",
                                            align: "end"
                                        }
                                    ]
                                }
                            ]
                        },
                        {
                            type: "separator",
                            margin: "xxl"
                        },
                        {
                            type: "box",
                            layout: "horizontal",
                            margin: "xxl",
                            contents: []
                        },
                        {
                            type: "text",
                            text: "Rain Drop Sensor",
                            size: "md",
                            color: "#555555",
                            weight: "bold"
                        },
                        {
                            type: "box",
                            layout: "horizontal",
                            contents: [
                                {
                                    type: "text",
                                    size: "sm",
                                    color: "#555555",
                                    text: "▪ ปริมาณน้ำฝน"
                                },
                                {
                                    type: "text",
                                    text: data.rain + " %",
                                    size: "sm",
                                    color: "#111111",
                                    align: "end"
                                }
                            ]
                        },



                        {
                            type: "separator",
                            margin: "xxl"
                        },
                        {
                            type: "box",
                            layout: "horizontal",
                            margin: "xxl",
                            contents: []
                        },
                        {
                            type: "text",
                            text: "Humidity Sensor",
                            size: "md",
                            color: "#555555",
                            weight: "bold"
                        },
                        {
                            type: "box",
                            layout: "horizontal",
                            contents: [
                                {
                                    type: "text",
                                    size: "sm",
                                    color: "#555555",
                                    text: "▪ ความชื้นในดิน"
                                },
                                {
                                    type: "text",
                                    text: data.humidity + " %",
                                    size: "sm",
                                    color: "#111111",
                                    align: "end"
                                }
                                
                                
                            ],
                            
                            paddingBottom: "md"
                        },
                        {
                          type: "separator",
                          margin: "xxl"
                      },
                      {
                          type: "box",
                          layout: "horizontal",
                          margin: "xxl",
                          contents: []
                      },
                      {
                          type: "text",
                          text: "Light Sensor",
                          size: "md",
                          color: "#555555",
                          weight: "bold"
                      },
                      {
                          type: "box",
                          layout: "horizontal",
                          contents: [
                              {
                                  type: "text",
                                  size: "sm",
                                  color: "#555555",
                                  text: "▪ ตรวจจับแสง"
                              },
                              {
                                  type: "text",
                                  text: data.light + " %",
                                  size: "sm",
                                  color: "#111111",
                                  align: "end"
                              }
                              
                              
                          ],
                          
                          paddingBottom: "md"
                      },

                      {
                        type: "separator",
                        margin: "xxl"
                    },
                      {
                        type: "box",
                        layout: "horizontal",
                        margin: "xxl",
                        contents: []
                    },
                    {
                        type: "text",
                        text: "Temp Air Sensor",
                        size: "md",
                        color: "#555555",
                        weight: "bold"
                    },
                    {
                        type: "box",
                        layout: "horizontal",
                        contents: [
                            {
                                type: "text",
                                size: "sm",
                                color: "#555555",
                                text: "▪ อุณหภูมิอากาศ"
                            },
                            {
                                type: "text",
                                text: data.temp_air + " °C",
                                size: "sm",
                                color: "#111111",
                                align: "end"
                            }
                        ],
                        paddingBottom: "md"
                    },



                    ]
                },
                
                styles: {
                    footer: {
                        separator: true
                    }
                }
            }
        };
        
            return client.replyMessage(event.replyToken, flexMessage);
        });
    } 
    else if (event.message.text.toLowerCase() === 'sensor') {
        return fetchLatestData().then(data => {
            const flexMessage = {
                type: "flex",
                altText: "Flex Message",
                contents: {
                  type: "bubble",
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
                        text: "📲 Sensor ",
                        margin: "none"
                      },
                    ],
                    margin: "none"
                  },
                  footer: {
                    type: "box",
                    layout: "vertical",
                    spacing: "md",
                    contents: [
                      {
                        "type": "button",
                        "style": "secondary",
                        "height": "sm",
                        "action": {
                          "type": "message",
                          "label": "TDS sensor",
                          "text": "tds"
                        }
                      },
                      {
                        "type": "button",
                        "style": "secondary",
                        "height": "sm",
                        "action": {
                          "type": "message",
                          "label": "Temp Sensor",
                          "text": "temp"
                        }
                      },
                      {
                        "type": "button",
                        "style": "secondary",
                        "height": "sm",
                        "action": {
                          "type": "message",
                          "label": "Rain Drop Sensor",
                          "text": "rain"
                        }
                      },
                      {
                        "type": "button",
                        "style": "secondary",
                        "height": "sm",
                        "action": {
                          "type": "message",
                          "label": "Humidity Sensor",
                          "text": "humidity"
                        }
                      },
                      {
                        "type": "button",
                        "style": "secondary",
                        "height": "sm",
                        "action": {
                          "type": "message",
                          "label": "Temp Air Sensor",
                          "text": "air_temp"
                        }
                      },
                      {
                        "type": "button",
                        "style": "secondary",
                        "height": "sm",
                        "action": {
                          "type": "message",
                          "label": "Light Sensor",
                          "text": "light"
                        }
                      },
                     
                      
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
              }else if(data.tds >= 0 && data.tds <= 300){
                var notify_wa = "✅ บริสุทธิ์ทั่วไป"
              }else if(data.tds >= 301 && data.tds <= 600){
                var notify_wa = "🟨 ควรปรับปรุง"
              }else{
                var notify_wa = "🟥 คุณภาพแย่"
              }
              const flexMessage = {
                "type": "flex",
                "altText": "Flex Message",
                "contents": {
                  "type": "bubble",
                  "size": "giga",
                  "hero": {
                    "type": "image",
                    "url": header_url+"/chart-tds",
                    "size": "full",
                    "aspectRatio": "8:6",
                    "aspectMode": "cover",
                    "action": {
                      "type": "uri",
                      "uri": header_url+"/chart-tds"
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
      return fetchLatestData().then(async data => {

        if (data.temp < 0 ){
          var notify = "❌ ไม่ปกติ"
        }else if(data.temp >= 0 && data.temp <= 21){
          var notify = "🟨 เย็นกว่าปกติ"
        }else if(data.temp >= 22 && data.temp <= 30){
          var notify = "✅ ปกติ"
        }else{
          var notify = "🟥 สูงกว่าปกติ"
        }

            const flexMessage = {
              "type": "flex",
              "altText": "Flex Message",
              "contents": {
                "type": "bubble",
                "size": "giga",
                "hero": {
                  "type": "image",
                  "url": header_url+"/chart-temp",
                  "size": "full",
                  "aspectRatio": "8:6",
                  "aspectMode": "cover",
                  "action": {
                    "type": "uri",
                    "uri": header_url+"/chart-temp"
                  }
                },
                "body": {
                  "type": "box",
                  "layout": "vertical",
                  "contents": [
                    {
                      "type": "text",
                      "text": "Temperature Sensor",
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
                              "text": "(1) อุณหภูมิของน้ำ",
                              "size": "md",
                              "flex": 5,
                              "margin": "none"
                            },
                            {
                              "type": "text",
                              "text": data.temp + " °C",
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
                              "text": "(2) สถานะของอุณหภูมิ",
                              "size": "md",
                              "flex": 5,
                              "margin": "none"
                            },
                            {
                              "type": "text",
                              "text": notify,
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
  } else if (event.message.text.toLowerCase() === 'rain') {
    return fetchLatestData().then(async data => {
      
        if (data.rain < 0 ){
            var notify_wa = "❌ ไม่ปกติ"
          }else if(data.rain >= 0 && data.rain<= 20){
            var notify_wa = "🟨 ต่ำ"
          }else if(data.rain >= 21 && data.rain <= 40){
            var notify_wa = "✅ ปกติ"
          }else{
            var notify_wa = "🟥 สูง"
          }
          const flexMessage = {
            "type": "flex",
            "altText": "Flex Message",
            "contents": {
              "type": "bubble",
              "size": "giga",
              "hero": {
                "type": "image",
                "url": header_url+"/chart-rain",
                "size": "full",
                "aspectRatio": "8:6",
                "aspectMode": "cover",
                "action": {
                  "type": "uri",
                  "uri": header_url+"/chart-rain"
                }
              },
              "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                  {
                    "type": "text",
                    "text": "Rain Drop Sensor",
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
                            "text": "(1) ปริมาณน้ำฝน",
                            "size": "md",
                            "flex": 5,
                            "margin": "none"
                          },
                          {
                            "type": "text",
                            "text": data.rain + " %",
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
                            "text": "(2) สถานะปริมาณน้ำฝน",
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
} else if (event.message.text.toLowerCase() === 'humidity') {
  return fetchLatestData().then(async data => {

    if (data.humidity < 0 ){
      var notify_humidity = "❌ ไม่ปกติ"
    }else if(data.humidity >= 0 && data.humidity<= 20){
      var notify_humidity = "🟨 น้อย"
    }else if(data.humidity >= 21 && data.humidity <= 40){
      var notify_humidity = "✅ ปกติ"
    }else{
      var notify_humidity = "🟥 มาก"
    }
    
        const flexMessage = {
          "type": "flex",
          "altText": "Flex Message",
          "contents": {
            "type": "bubble",
            "size": "giga",
            "hero": {
              "type": "image",
              "url": header_url+"/chart-humidity",
              "size": "full",
              "aspectRatio": "8:6",
              "aspectMode": "cover",
              "action": {
                "type": "uri",
                "uri": header_url+"/chart-humidity"
              }
            },
            "body": {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": "Humidity Sensor",
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
                          "text": "(1) ความชื้นในดิน",
                          "size": "md",
                          "flex": 5,
                          "margin": "none"
                        },
                        {
                          "type": "text",
                          "text": data.humidity + " %",
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
                          "text": "(2) สถานะความชื้นในดิน",
                          "size": "md",
                          "flex": 5,
                          "margin": "none"
                        },
                        {
                          "type": "text",
                          "text": notify_humidity,
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
} else if (event.message.text.toLowerCase() === 'air_temp') {
  return fetchLatestData().then(async data => {

    if (data.temp_air < 0 ){
      var notify_temp_air = "❌ ไม่ปกติ"
    }else if(data.temp_air >= 0 && data.temp_air <= 21){
      var notify_temp_air = "🟨 เย็นกว่าปกติ"
    }else if(data.temp_air >= 22 && data.temp_air <= 30){
      var notify_temp_air = "✅ ปกติ"
    }else{
      var notify_temp_air = "🟥 สูงกว่าปกติ"
    }
    
        const flexMessage = {
          "type": "flex",
          "altText": "Flex Message",
          "contents": {
            "type": "bubble",
            "size": "giga",
            "hero": {
              "type": "image",
              "url": header_url+"/chart-temp_air",
              "size": "full",
              "aspectRatio": "8:6",
              "aspectMode": "cover",
              "action": {
                "type": "uri",
                "uri": header_url+"/chart-temp_air"
              }
            },
            "body": {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": "Temp Air Sensor",
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
                          "text": "(1) อุณหภูมิอากาศ",
                          "size": "md",
                          "flex": 5,
                          "margin": "none"
                        },
                        {
                          "type": "text",
                          "text": data.temp_air + " °C",
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
                          "text": "(2) สถานะอุณหภูมิอากาศ",
                          "size": "md",
                          "flex": 5,
                          "margin": "none"
                        },
                        {
                          "type": "text",
                          "text": notify_temp_air,
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
} 

else if (event.message.text.toLowerCase() === 'light') {
  return fetchLatestData().then(async data => {

    if (data.light < 0 ){
      var notify_light = "❌ ไม่ปกติ"
    }else if(data.light >= 0 && data.light <= 40){
      var notify_light = "🟨 น้อยกว่าปกติ"
    }else if(data.light >= 41 && data.light <= 70){
      var notify_light = "✅ ปกติ"
    }else{
      var notify_light = "🟥 สูงกว่าปกติ"
    }
    
        const flexMessage = {
          "type": "flex",
          "altText": "Flex Message",
          "contents": {
            "type": "bubble",
            "size": "giga",
            "hero": {
              "type": "image",
              "url": header_url+"/chart-light",
              "size": "full",
              "aspectRatio": "8:6",
              "aspectMode": "cover",
              "action": {
                "type": "uri",
                "uri": header_url+"/chart-light"
              }
            },
            "body": {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": "Light Sensor",
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
                          "text": "(1) ความเข้มแสง",
                          "size": "md",
                          "flex": 5,
                          "margin": "none"
                        },
                        {
                          "type": "text",
                          "text": data.light + " %",
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
                          "text": "(2) สถานะความเข้มแสง",
                          "size": "md",
                          "flex": 5,
                          "margin": "none"
                        },
                        {
                          "type": "text",
                          "text": notify_light,
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
}

else if (event.message.text.toLowerCase() === 'stats_tds') {
      return fetchLatestData().then(data => {
        const flexMessage = {
          "type": "flex",
          "altText": "Flex Message",
          "contents": {
            "type": "bubble",
            "size": "kilo",
            "body": {
              "type": "box",
              "layout": "vertical",
              "contents": [
                {
                  "type": "text",
                  "text": "📊 TDS!",
                  "weight": "bold",
                  "size": "xxl"
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "vertical",
                  "margin": "lg",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "box",
                      "layout": "baseline",
                      "spacing": "sm",
                      "contents": [
                        {
                          "type": "text",
                          "text": "STEP 1",
                          "size": "sm",
                          "flex": 2
                        },
                        {
                          "type": "text",
                          "text": "จำนวนแถวทั้งหมดคือ "+`${data.rows}\n`+ "เลือกค่าย้อนหลังที่ต้องการ!",
                          "wrap": true,
                          "size": "sm",
                          "flex": 5
                        }
                      ]
                    },
                    {
                      type: "separator",
                      margin: "xxl"
                    },
                    {
                      "type": "box",
                      "layout": "baseline",
                      "spacing": "sm",
                      "contents": [
                        {
                          "type": "text",
                          "text": "STEP 2",
                          "size": "sm",
                          "flex": 2
                        },
                        {
                          "type": "text",
                          "text": "ใช้คำสั่ง tds(ตามด้วย\nจำนวนแถวที่ต้องการดู!)",
                          "wrap": true,
                          "size": "sm",
                          "flex": 5
                        }
                      ]
                    },
                    {
                      type: "separator",
                      margin: "xxl"
                    },
                    {
                      "type": "box",
                      "layout": "baseline",
                      "spacing": "sm",
                      "contents": [
                        {
                          "type": "text",
                          "text": "EX 1",
                          "size": "sm",
                          "flex": 2
                        },
                        {
                          "type": "text",
                          "text": "tds"+`${data.rows}`,
                          "wrap": true,
                          "size": "sm",
                          "flex": 5
                        }
                      ]
                    }
                  ]
                }
              ]
            },
            footer: {
              type: "box",
              layout: "vertical",
              spacing: "md",
              contents: [
                {
                  "type": "button",
                  "style": "secondary",
                  "height": "sm",
                  "action": {
                    "type": "message",
                    "label": "แสดงแถวทั้งหมด",
                    "text": "tds9999999"
                  }
                },
                {
                  "type": "button",
                  "style": "primary",
                  "height": "sm",
                  "action": {
                    "type": "message",
                    "label": "⬅️ Statistics",
                    "text": "statistics"
                  },
                  "color": "#090c25"
                }
                
              ],
              margin: "none"
            },
          }
        };
        
          return client.replyMessage(event.replyToken, flexMessage);
      });
      
  }

  else if (event.message.text.toLowerCase() === 'stats_temp') {
    return fetchLatestData().then(data => {
      const flexMessage = {
        "type": "flex",
        "altText": "Flex Message",
        "contents": {
          "type": "bubble",
          "size": "kilo",
          "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
              {
                "type": "text",
                "text": "📊 Temp!",
                "weight": "bold",
                "size": "xl"
              },
              {
                type: "separator",
                margin: "xxl"
              },
              {
                "type": "box",
                "layout": "vertical",
                "margin": "lg",
                "spacing": "sm",
                "contents": [
                  {
                    "type": "box",
                    "layout": "baseline",
                    "spacing": "sm",
                    "contents": [
                      {
                        "type": "text",
                        "text": "STEP 1",
                        "size": "sm",
                        "flex": 2
                      },
                      {
                        "type": "text",
                        "text": "จำนวนแถวทั้งหมดคือ "+`${data.rows}\n`+ "เลือกค่าย้อนหลังที่ต้องการ!",
                        "wrap": true,
                        "size": "sm",
                        "flex": 5
                      }
                    ]
                  },
                  {
                    type: "separator",
                    margin: "xxl"
                  },
                  {
                    "type": "box",
                    "layout": "baseline",
                    "spacing": "sm",
                    "contents": [
                      {
                        "type": "text",
                        "text": "STEP 2",
                        "size": "sm",
                        "flex": 2
                      },
                      {
                        "type": "text",
                        "text": "ใช้คำสั่ง temp(ตามด้วย\nจำนวนแถวที่ต้องการดู!)",
                        "wrap": true,
                        "size": "sm",
                        "flex": 5
                      }
                    ]
                  },
                  {
                    type: "separator",
                    margin: "xxl"
                  },
                  {
                    "type": "box",
                    "layout": "baseline",
                    "spacing": "sm",
                    "contents": [
                      {
                        "type": "text",
                        "text": "EX 1",
                        "size": "sm",
                        "flex": 2
                      },
                      {
                        "type": "text",
                        "text": "temp"+`${data.rows}`,
                        "wrap": true,
                        "size": "sm",
                        "flex": 5
                      }
                    ]
                  }
                ]
              }
            ]
          },
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
              {
                "type": "button",
                "style": "secondary",
                "height": "sm",
                "action": {
                  "type": "message",
                  "label": "แสดงแถวทั้งหมด",
                  "text": "temp9999999"
                }
              },
              {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                  "type": "message",
                  "label": "⬅️ Statistics",
                  "text": "statistics"
                },
                "color": "#090c25"
              }
              
            ],
            margin: "none"
          },
        }
      };
      
        return client.replyMessage(event.replyToken, flexMessage);
    });
    
}else if (event.message.text.toLowerCase() === 'stats_humidity') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "📊 Humidity!",
              "weight": "bold",
              "size": "xxl"
            },
            {
              type: "separator",
              margin: "xxl"
            },
            {
              "type": "box",
              "layout": "vertical",
              "margin": "lg",
              "spacing": "sm",
              "contents": [
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "จำนวนแถวทั้งหมดคือ "+`${data.rows}\n`+ "เลือกค่าย้อนหลังที่ต้องการ!",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 2",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "ใช้คำสั่ง humidity(ตามด้วย\nจำนวนแถวที่ต้องการดู!)",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "EX 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "humidity"+`${data.rows}`,
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                }
              ]
            }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "แสดงแถวทั้งหมด",
                "text": "humidity9999999"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Statistics",
                "text": "statistics"
              },
              "color": "#090c25"
            }
            
          ],
          margin: "none"
        },
      }
    };
    
      return client.replyMessage(event.replyToken, flexMessage);
  });
  
}else if (event.message.text.toLowerCase() === 'stats_rain') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "📊 Rain Drop!",
              "weight": "bold",
              "size": "xxl"
            },
            {
              type: "separator",
              margin: "xxl"
            },
            {
              "type": "box",
              "layout": "vertical",
              "margin": "lg",
              "spacing": "sm",
              "contents": [
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "จำนวนแถวทั้งหมดคือ "+`${data.rows}\n`+ "เลือกค่าย้อนหลังที่ต้องการ!",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 2",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "ใช้คำสั่ง rain(ตามด้วย\nจำนวนแถวที่ต้องการดู!)",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "EX 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "rain"+`${data.rows}`,
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                }
              ]
            }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "แสดงแถวทั้งหมด",
                "text": "rain9999999"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Statistics",
                "text": "statistics"
              },
              "color": "#090c25"
            }
            
          ],
          margin: "none"
        },
      }
    };
    
      return client.replyMessage(event.replyToken, flexMessage);
  });


  
}else if (event.message.text.toLowerCase() === 'stats_air_temp') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "📊 Temp Air!",
              "weight": "bold",
              "size": "xxl"
            },
            {
              type: "separator",
              margin: "xxl"
            },
            {
              "type": "box",
              "layout": "vertical",
              "margin": "lg",
              "spacing": "sm",
              "contents": [
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "จำนวนแถวทั้งหมดคือ "+`${data.rows}\n`+ "เลือกค่าย้อนหลังที่ต้องการ!",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 2",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "ใช้คำสั่ง air(ตามด้วย\nจำนวนแถวที่ต้องการดู!)",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "EX 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "air"+`${data.rows}`,
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                }
              ]
            }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "แสดงแถวทั้งหมด",
                "text": "air9999999"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Statistics",
                "text": "statistics"
              },
              "color": "#090c25"
            }
            
          ],
          margin: "none"
        },
      }
    };
    
      return client.replyMessage(event.replyToken, flexMessage);
  });
  
}else if (event.message.text.toLowerCase() === 'stats_light') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "📊 Light!",
              "weight": "bold",
              "size": "xxl"
            },
            {
              type: "separator",
              margin: "xxl"
            },
            {
              "type": "box",
              "layout": "vertical",
              "margin": "lg",
              "spacing": "sm",
              "contents": [
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "จำนวนแถวทั้งหมดคือ "+`${data.rows}\n`+ "เลือกค่าย้อนหลังที่ต้องการ!",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 2",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "ใช้คำสั่ง light(ตามด้วย\nจำนวนแถวที่ต้องการดู!)",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "EX 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "light"+`${data.rows}`,
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                }
              ]
            }
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "แสดงแถวทั้งหมด",
                "text": "light9999999"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Statistics",
                "text": "statistics"
              },
              "color": "#090c25"
            }
            
          ],
          margin: "none"
        },
      }
    };
    
      return client.replyMessage(event.replyToken, flexMessage);
  });
  
}




else if (event.message.text.toLowerCase() === 'statistics') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      type: "flex",
      altText: "Flex Message",
      contents: {
        type: "bubble",
        size: "kilo",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "text",
              text: "📊 Statistics",
              weight: "bold",
              size: "xxl",
              margin: "none"
            },
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "TDS Sensor",
                "text": "stats_tds"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Temp Sensor",
                "text": "stats_temp"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Rain Drop Sensor",
                "text": "stats_rain"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Humidity Sensor",
                "text": "stats_humidity"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Temp Air Sensor",
                "text": "stats_air_temp"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Light Sensor",
                "text": "stats_light"
              }
            },
          ],
          flex: 0
        }
      }
    };
        
      return client.replyMessage(event.replyToken, flexMessage);
  });
}  
else if (event.message.text.toLowerCase() === 'setting') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      type: "flex",
      altText: "Flex Message",
      contents: {
        type: "bubble",
        size: "kilo",
        body: {
          type: "box",
          layout: "vertical",
          contents: [
            {
              type: "text",
              text: "⚙️ Setting",
              weight: "bold",
              size: "xxl",
              margin: "none"
            },
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "LED",
                "text": "led_console"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Water Pump",
                "text": "pump_console"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Data Console",
                "text": "data_console"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "uri",
                "label": "Control Monitor",
                "uri": "https://water-bot-222609226e9c.herokuapp.com/graph"
              },
              "color": "#090c25"
            },
          ],
          margin: "none"
        },
      }
    };
    
        
      return client.replyMessage(event.replyToken, flexMessage);
  });
} else if (event.message.text.toLowerCase() === 'led_console') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "💡 LED",
              "weight": "bold",
              "size": "xxl",
              "margin": "none"
            },
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Turn on",
                "text": "on_led"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Turn off",
                "text": "off_led"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Set Timer",
                "text": "timer_command"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Setting",
                "text": "setting"
              },
              "color": "#090c25"
            }
            
          ],
          margin: "none"
        },
      }
    };
    
        
      return client.replyMessage(event.replyToken, flexMessage);
  });
}else if (event.message.text.toLowerCase() === 'pump_console') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "💧 Pump",
              "weight": "bold",
              "size": "xxl",
              "margin": "none"
            },
          ]
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Turn on",
                "text": "on_pump"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Turn off",
                "text": "off_pump"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "Set Timer",
                "text": "pump_command"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Setting",
                "text": "setting"
              },
              "color": "#090c25"
            }
            
          ],
          margin: "none"
        },
      }
    };
    
        
      return client.replyMessage(event.replyToken, flexMessage);
  });
}
else if (event.message.text.toLowerCase() === 'timer_command') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "🕐 Timer",
              "weight": "bold",
              "size": "xxl"
            },
            {
              type: "separator",
              margin: "xxl"
            },
            {
              "type": "box",
              "layout": "vertical",
              "margin": "lg",
              "spacing": "sm",
              "contents": [
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "กรุณาเลือกระยะเวลา(วินาที) เพื่อการกำหนดค่าเวลา",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 2",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "ใช้คำสั่ง time(ตามค่าเวลา\nที่ต้องการกำหนดค่า)",
                      "wrap": true,
                      "color": "#666666",
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "EX 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "time20 (หมายถึง 20 วินาที)",
                      "wrap": true,
                      "color": "#666666",
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                }
              ]
            }
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "~ 10 วินาที",
                "text": "time10"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "~ 30 วินาที",
                "text": "time30"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "❌ ยกเลิก",
                "text": "off_led"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ LED Console",
                "text": "led_console"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
    };
    
    
        
      return client.replyMessage(event.replyToken, flexMessage);
  });
}else if (event.message.text.toLowerCase() === 'data_console') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "📁 Fetch Data",
              "weight": "bold",
              "size": "xxl"
            },
            {
              type: "separator",
              margin: "xxl"
            },
            {
              "type": "box",
              "layout": "vertical",
              "margin": "lg",
              "spacing": "sm",
              "contents": [
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "กรุณาเลือกระยะเวลา(วินาที) เพื่อการกำหนดค่าเวลา",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 2",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "ใช้คำสั่ง set(ตามค่าเวลา\nที่ต้องการกำหนดค่า)",
                      "wrap": true,
                      "color": "#666666",
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "EX 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "set20 (หมายถึง 20 วินาที)",
                      "wrap": true,
                      "color": "#666666",
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                }
                ,
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 3",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "ค่าปัจจุบันคือ: "+`${data.data_fecth}`+' วินาที',
                      "wrap": true,
                      "color": "#666666",
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                }
              ]
            }
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "ทุกๆ 10 วินาที",
                "text": "set10"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "ทุกๆ 30 วินาที",
                "text": "set30"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Setting",
                "text": "setting"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
    };
    
    
        
      return client.replyMessage(event.replyToken, flexMessage);
  });
}
else if (event.message.text.toLowerCase() === 'pump_command') {
  return fetchLatestData().then(data => {
    const flexMessage = {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "🕐 Timer",
              "weight": "bold",
              "size": "xxl"
            },
            {
              type: "separator",
              margin: "xxl"
            },
            {
              "type": "box",
              "layout": "vertical",
              "margin": "lg",
              "spacing": "sm",
              "contents": [
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "กรุณาเลือกระยะเวลา(วินาที) เพื่อการกำหนดค่าเวลา",
                      "wrap": true,
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "STEP 2",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "ใช้คำสั่ง pump(ตามค่าเวลา\nที่ต้องการกำหนดค่า)",
                      "wrap": true,
                      "color": "#666666",
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                },
                {
                  type: "separator",
                  margin: "xxl"
                },
                {
                  "type": "box",
                  "layout": "baseline",
                  "spacing": "sm",
                  "contents": [
                    {
                      "type": "text",
                      "text": "EX 1",
                      "size": "sm",
                      "flex": 2
                    },
                    {
                      "type": "text",
                      "text": "pump20 (หมายถึง 20 วินาที)",
                      "wrap": true,
                      "color": "#666666",
                      "size": "sm",
                      "flex": 5
                    }
                  ]
                }
              ]
            }
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "~ 10 วินาที",
                "text": "pump10"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "~ 30 วินาที",
                "text": "pump30"
              }
            },
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "❌ ยกเลิก",
                "text": "off_pump"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Pump Console",
                "text": "pump_console"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
    };
    
    
        
      return client.replyMessage(event.replyToken, flexMessage);
  });
}
else if (match_time) {
  const valueAfterAvgTds = match_time[1];
  mqttClient.publish('/topic/qos0', 'on_led_'+`${valueAfterAvgTds}`+'.0', { qos: 0 }, (error) => {
    if (error) {
        console.error('Error Publishing: ', error);
    }
    return client.replyMessage(event.replyToken, {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "เวลาทำงาน: "+`${valueAfterAvgTds}`+" วินาที",
              "weight": "bold",
              "size": "xl"
            },
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "❌ ยกเลิก",
                "text": "off_led"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ LED Console",
                "text": "led_console"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
  });
});
}
else if (match_pump) {
  const valueAfterAvgTds = match_pump[1];
  mqttClient.publish('/topic/qos0', 'on_pump_'+`${valueAfterAvgTds}`+'.0', { qos: 0 }, (error) => {
    if (error) {
        console.error('Error Publishing: ', error);
    }
    return client.replyMessage(event.replyToken, {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "เวลาทำงาน: "+`${valueAfterAvgTds}`+" วินาที",
              "weight": "bold",
              "size": "xl"
            },
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "❌ ยกเลิก",
                "text": "off_pump"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Pump Console",
                "text": "pump_console"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
  });
});
}
else if (match_time) {
  const valueAfterAvgTds = match_time[1];
  mqttClient.publish('/topic/qos0', 'on_led_'+`${valueAfterAvgTds}`+'.0', { qos: 0 }, (error) => {
    if (error) {
        console.error('Error Publishing: ', error);
    }
    return client.replyMessage(event.replyToken, {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "เวลาทำงาน: "+`${valueAfterAvgTds}`+" วินาที",
              "weight": "bold",
              "size": "xl"
            },
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "secondary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "❌ ยกเลิก",
                "text": "off_led"
              }
            },
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ LED Console",
                "text": "led_console"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
  });
});
}
else if (match_set_data) {
  const valueAfterAvgTds = match_set_data[1];
  mqttClient.publish('/topic/qos0', 'set_data_'+`${valueAfterAvgTds}`+'.0', { qos: 0 }, (error) => {
    if (error) {
        console.error('Error Publishing: ', error);
    }
    return client.replyMessage(event.replyToken, {
      "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "บันทึกค่าทุกๆ: "+`${valueAfterAvgTds}`+" วินาที",
              "weight": "bold",
              "size": "xl"
            },
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ Data Console",
                "text": "data_console"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
  });
});
}

    else if (event.message.text.toLowerCase() === 'on_led') {
        mqttClient.publish('/topic/qos0', 'on_led', { qos: 0 }, (error) => {
            if (error) {
                console.error('Error Publishing: ', error);
            }
            return client.replyMessage(event.replyToken, {
              "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "สถานะ: ✅ เปิดแล้ว",
              "weight": "bold",
              "size": "xl"
            },
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ LED Console",
                "text": "led_console"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
          });
        });
    }
    else if (event.message.text.toLowerCase() === 'on_pump') {
      mqttClient.publish('/topic/qos0', 'on_pump', { qos: 0 }, (error) => {
          if (error) {
              console.error('Error Publishing: ', error);
          }
          return client.replyMessage(event.replyToken, {
            "type": "flex",
    "altText": "Flex Message",
    "contents": {
      "type": "bubble",
      "size": "kilo",
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          {
            "type": "text",
            "text": "สถานะ: ✅ เปิดแล้ว",
            "weight": "bold",
            "size": "xl"
          },
        ]
      },
      "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "md",
        "contents": [
          {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
              "type": "message",
              "label": "⬅️ Pump Console",
              "text": "Pump_console"
            },
            "color": "#090c25"
          },
          {
            "type": "box",
            "layout": "vertical",
            "contents": [],
            "margin": "sm"
          }
        ],
        "flex": 0
      }
    }
        });
      });
  }
    else if (event.message.text.toLowerCase() === 'off_led') {
      mqttClient.publish('/topic/qos0', 'off_led', { qos: 0 }, (error) => {
          if (error) {
              console.error('Error Publishing: ', error);
          }
          return client.replyMessage(event.replyToken, {
            "type": "flex",
      "altText": "Flex Message",
      "contents": {
        "type": "bubble",
        "size": "kilo",
        "body": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "สถานะ: ❎ ปิดแล้ว",
              "weight": "bold",
              "size": "xl"
            },
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "button",
              "style": "primary",
              "height": "sm",
              "action": {
                "type": "message",
                "label": "⬅️ LED Console",
                "text": "led_console"
              },
              "color": "#090c25"
            },
            {
              "type": "box",
              "layout": "vertical",
              "contents": [],
              "margin": "sm"
            }
          ],
          "flex": 0
        }
      }
        });
      });
  }
  else if (event.message.text.toLowerCase() === 'off_pump') {
    mqttClient.publish('/topic/qos0', 'off_pump', { qos: 0 }, (error) => {
        if (error) {
            console.error('Error Publishing: ', error);
        }
        return client.replyMessage(event.replyToken, {
          "type": "flex",
    "altText": "Flex Message",
    "contents": {
      "type": "bubble",
      "size": "kilo",
      "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
          {
            "type": "text",
            "text": "สถานะ: ❎ ปิดแล้ว",
            "weight": "bold",
            "size": "xl"
          },
        ]
      },
      "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "md",
        "contents": [
          {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
              "type": "message",
              "label": "⬅️ Pump Console",
              "text": "pump_console"
            },
            "color": "#090c25"
          },
          {
            "type": "box",
            "layout": "vertical",
            "contents": [],
            "margin": "sm"
          }
        ],
        "flex": 0
      }
    }
      });
    });
} else {  
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'ขอโทษครับ/ค่ะ ฉันไม่เข้าใจคำถาม'
        });
    }
}


//------------------------จบส่วนติดต่อกับ Line OA ทั้งหมด Res,Req--------------------------//






//------------------------เริ่มสร้าง Websocket , MQTT และเปิด Server--------------------------//
const port = process.env.PORT || 3000;

const server = app.listen(port, () => console.log(`Server is running on port ${port}`));
const wss = new Server({ server });

wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');

  mqttClient.on('message', (topic, message) => {
    if (topic === MQTT_TOPIC_HUMIDITY || topic === MQTT_TOPIC_TDS || topic === MQTT_TOPIC_TEMP_AIR || topic === MQTT_TOPIC_TEMP || topic === MQTT_TOPIC_LIGHT || topic === MQTT_TOPIC_RAIN ) {
      const data = { topic, message: message.toString() };
      ws.send(JSON.stringify(data));
    }
  });
});


mqttClient.on('message', (topic, message) => {
  if (topic === MQTT_TOPIC_HUMIDITY) {
      latestHumidity = parseFloat(message.toString());
  } else if (topic === MQTT_TOPIC_TEMP) {
      latestTemperature = parseFloat(message.toString());
  }else if (topic === MQTT_TOPIC_TEMP_AIR) {
    latestTemp_air = parseFloat(message.toString());
}else if (topic === MQTT_TOPIC_RAIN) {
  latestRain = parseFloat(message.toString());
}else if (topic === MQTT_TOPIC_TDS) {
  latestTds = parseFloat(message.toString());
}else if (topic === MQTT_TOPIC_LIGHT) {
  latestLight = parseFloat(message.toString());
}
});

//------------------------จบการทำงาน Websocket , MQTT และเปิด Server--------------------------//
