const express = require('express');
const app = express();
app.use(require('./lib/app'));
module.exports = app;
