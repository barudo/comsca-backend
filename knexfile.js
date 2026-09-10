const path = require("node:path");
require("dotenv").config();

module.exports = {
  client: "pg",
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: path.join(__dirname, "migrations"),
  },
};
