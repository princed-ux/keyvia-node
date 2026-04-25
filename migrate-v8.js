import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA PLATFORM - DATABASE MIGRATION V8");
  console.log("Adding profile social links + rejection reason...");
  console.log("===============================================\n");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    console.log("✅ Transaction started\n");

    // 1. Add social_links to profiles
    await client.query(`
      ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}'::jsonb;
    `);
    console.log("✅ profiles.social_links ready");

    // 2. Add rejection_reason to users
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
    `);
    console.log("✅ users.rejection_reason ready");

    // Optional helpful indexes later can go here

    await client.query("COMMIT");
    console.log("\n✅ Migration V8 completed successfully!\n");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration V8 failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();