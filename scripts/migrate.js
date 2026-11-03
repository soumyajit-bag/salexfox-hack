"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString) {
  console.error("Set DATABASE_URL_UNPOOLED to a direct Neon connection string before migrating.");
  process.exit(1);
}
if (new URL(connectionString).hostname.includes("-pooler.")) {
  console.error("Migrations require the direct, non-pooled Neon connection string.");
  process.exit(1);
}

async function migrate() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const directory = path.join(__dirname, "..", "migrations");
    const files = fs.readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    for (const name of files) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["scalefox-hack:migrations"]);
        const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
        if (applied.rowCount) {
          await client.query("COMMIT");
          continue;
        }

        await client.query(fs.readFileSync(path.join(directory, name), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.log("Applied " + name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

migrate().catch((error) => {
  console.error("Database migration failed:", error.message);
  process.exitCode = 1;
});
