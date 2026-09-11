const path = require("node:path");
require("dotenv").config({ quiet: true });

module.exports = {
  client: "pg",
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 2 },
  migrations: {
    directory: path.join(__dirname, "migrations"),
  },
};
