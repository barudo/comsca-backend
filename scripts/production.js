const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const values = require("dotenv").parse(fs.readFileSync(path.join(root, ".env.production")));
const action = process.argv[2];
if (!["deploy", "migrate"].includes(action)) throw new Error("Expected deploy or migrate");
const databaseUrl = action === "migrate"
  ? values.MIGRATION_DATABASE_URL || values.DATABASE_URL
  : values.DATABASE_URL;
if (!databaseUrl) throw new Error("Missing production database URL");
const url = new URL(databaseUrl);
if (!url.hostname.endsWith(".supabase.co") && !url.hostname.endsWith(".supabase.com")) {
  throw new Error("Production database must be a Supabase host");
}
console.log(`${action}: production database ${url.hostname}:${url.port || 5432}`);
const command = action === "deploy" ? "serverless" : process.execPath;
const args = action === "deploy"
  ? ["deploy", "--stage", "prod"]
  : [require.resolve("knex/bin/cli.js"), "migrate:latest"];
const result = spawnSync(command, args, {
  cwd: root,
  env: { ...process.env, ...values, DATABASE_URL: databaseUrl },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
