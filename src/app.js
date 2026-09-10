const express = require("express");
const db = require("./db");
const loadRoutes = require("./api");
const groupSlugMiddleware = require("./middleware/group-slug");

function createApp(database = db) {
  const app = express();

  app.use(express.json());
  app.use(groupSlugMiddleware(database));

  app.get("/", (_request, response) => {
    response.json({
      success: true,
      message: "On this site will rise the awesome",
    });
  });

  loadRoutes(app, `${__dirname}/api`, "/api");

  app.use((error, _request, response, _next) => {
    if (error.code === "ECONNREFUSED") {
      return response.status(503).json({
        success: false,
        error: "Database unavailable",
      });
    }

    return response.status(500).json({
      success: false,
      error: "Internal server error",
    });
  });

  return app;
}

module.exports = createApp();
module.exports.createApp = createApp;
