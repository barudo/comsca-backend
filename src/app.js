const express = require("express");
const db = require("./db");
const createRouter = require("./routes");

function createApp(database = db, services = {}) {
  const app = express();
  app.locals.database = database;
  app.locals.services = services;
  app.use(require("./middleware/cors"));
  app.use((request, response, next) => {
    if (!/^\/api\/v1(?:\/|$)/i.test(request.path)) {
      return response.status(404).json({ success: false, error: "Not found" });
    }
    return next();
  });

  app.use(createRouter(database));

  app.use((error, _request, response, _next) => {
    if (error.type === "entity.parse.failed") {
      return response.status(400).json({ success: false, error: "Invalid JSON body" });
    }
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
