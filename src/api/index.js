const fs = require("node:fs");
const path = require("node:path");

function loadRoutes(app, routesDirectory, routePrefix = "") {
  for (const entry of fs.readdirSync(routesDirectory, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(routesDirectory, entry.name);

    if (entry.isDirectory()) {
      loadRoutes(app, entryPath, `${routePrefix}/${entry.name}`);
      continue;
    }

    if (
      !entry.isFile() ||
      !entry.name.endsWith(".js") ||
      entry.name === "index.js"
    ) {
      continue;
    }

    const routeName = path.basename(entry.name, ".js");
    app.use(`${routePrefix}/${routeName}`, require(entryPath));
  }
}

module.exports = loadRoutes;
