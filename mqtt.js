const mqtt = require('mqtt');
const fs = require('fs');
const line = require('@line/bot-sdk');

const caFile = fs.readFileSync('emqxsl-ca.crt');

const mqttClient = mqtt.connect('mqtts://qce3dfea.ala.us-east-1.emqxsl.com:8883', {
    username: 'gamu',
    password: '555',
    ca: caFile
});

mqttClient.on('connect', function () {
    console.log('Connected to MQTT Broker');
});

mqttClient.on('error', function (error) {
    console.error('Error in MQTT: ', error);
});

module.exports = mqttClient;
