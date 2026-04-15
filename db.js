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
  ssl: {
    rejectUnauthorized: false // 👈 THIS IS REQUIRED FOR AWS RDS
  }
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