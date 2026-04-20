// db.js
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pkg;

export const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,

  // ✅ OPTIMIZED CONNECTION POOLING FOR SCALABILITY
  max: 20, // Max 20 connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Timeout connection attempt after 5s (increased from 2s for reliability)
  statement_timeout: 30000, // Query timeout: 30 seconds

  ssl: {
    rejectUnauthorized: false, // 👈 THIS IS REQUIRED FOR AWS RDS
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
