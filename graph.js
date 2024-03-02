const express = require('express');
const router = express.Router();
const {google} = require("googleapis");
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const FormData = require('form-data');
const line = require('@line/bot-sdk');

const mqttClient = require('./mqtt');

router.use(express.json());


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

router.get('/', (req, res, next) => {
   
        res.render('page');
          
 });

 router.post('/scroll', (req, res) => {
    const value = req.body.value;
  console.log('Received value from client:', value);
  

  mqttClient.publish('/topic/qos0', 'config_light_'+`${value}`+'.0', { qos: 0 }, (error) =>{

  });
  res.send({ message: 'Received value successfully' });
  });

router.get('/fetch-latest-data-tds', async (req, res) => {
    try {
        const data = await fetchLatestData_tds();
        if (!data) {
            return res.status(404).send('Data not found');
        }
        res.json(data);
    } catch (error) {
        console.error('Error fetching latest data:', error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
