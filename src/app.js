const express = require('express');

const app = express();

app.get('/', (_request, response) => {
  response.json({
    success: true,
    message: 'On this site will rise the awesome'
  });
});

module.exports = app;
