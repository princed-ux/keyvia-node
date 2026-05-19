// db.js
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pkg;

const NODE_ENV = process.env.NODE_ENV || "development";

// In development, allow self-signed certs by default.
// Override with DB_SSL_REJECT_UNAUTHORIZED=true in production.
const rejectUnauthorized =
  process.env.DB_SSL_REJECT_UNAUTHORIZED !== undefined
    ? process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false"
    : NODE_ENV !== "development";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  query_timeout: 30000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  ssl: {
    rejectUnauthorized,
  },
});

// Test connection immediately
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ PostgreSQL connection error:", err.stack);
  } else {
    console.log("✅ Connected to AWS PostgreSQL");
    release();
  }
});

pool.on("error", (err) => {
  console.error("❌ PostgreSQL pool error:", err);
});
