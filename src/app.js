const express = require("express");
const db = require("./db");
const loadRoutes = require("./api");
const groupSlugMiddleware = require("./middleware/group-slug");

function createApp(database = db, services = {}) {
  const app = express();
  app.locals.database = database;
  app.locals.services = services;
  app.use(require("./middleware/cors"));

  // Verify Supabase signatures against the original bytes, before JSON parsing.
  app.use("/api/v1/hooks", express.raw({ type: "application/json", limit: "32kb" }), require("./api/v1/hooks"));
  app.use(express.json({ limit: "32kb" }));
  // A new group does not exist yet, so registration cannot require its header.
  app.use("/api/v1/user", require("./api/v1/user"));
  app.use(["/groups", "/api/v1/groups"], require("./api/v1/groups"));
  app.use("/api/v1/auth", require("./routes/supabase-auth"));
  app.use(groupSlugMiddleware(database));
  app.use(["/groups", "/api/v1/groups"], require("./routes/group-user-list"));
  app.use(["/groups/users", "/api/v1/groups/users"], require("./routes/group-user-accounts"));
  app.use(["/user", "/api/v1/user", "/groups/users", "/api/v1/groups/users"], require("./routes/group-users"));
  app.use(["/users", "/api/v1/users"], require("./routes/users"));
  app.use(["/cycles", "/api/v1/cycles"], require("./routes/cycles"));

  app.get("/", (_request, response) => {
    response.json({
      success: true,
      message: "On this site will rise the awesome",
    });
  });

  loadRoutes(app, `${__dirname}/api`, "/api");

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
