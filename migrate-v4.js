// migrate-v4.js
// ============================================================================
// DATABASE MIGRATION TO ADD MISSING ADMIN COLUMNS
// Run with: node migrate-v4.js
// ============================================================================

import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA PLATFORM - DATABASE MIGRATION V4");
  console.log("Adding missing admin columns...");
  console.log("=========================================\n");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    console.log("✅ Transaction started\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: ADD MISSING COLUMNS TO USERS TABLE
    // ═══════════════════════════════════════════════════════════════════════
    console.log("👥 Adding missing columns to users table...");

    // Check and add is_admin column
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
    `);
    console.log("✅ is_admin column added");

    // Check and add is_super_admin column
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;
    `);
    console.log("✅ is_super_admin column added");

    // Check and add special_id column (for admin identification)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS special_id VARCHAR(100) UNIQUE;
    `);
    console.log("✅ special_id column added\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: ENSURE PROFILES TABLE HAS THESE COLUMNS TOO
    // ═══════════════════════════════════════════════════════════════════════
    console.log("👤 Checking profiles table...");

    // Check if profiles table exists and add columns if needed
    const tableCheckResult = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'profiles'
      );
    `);

    if (tableCheckResult.rows[0].exists) {
      await client.query(`
        ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
      `);
      console.log("✅ profiles.is_admin column added");

      await client.query(`
        ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;
      `);
      console.log("✅ profiles.is_super_admin column added");
    }

    console.log("\n");

    await client.query("COMMIT");
    console.log("✅ Migration V4 completed successfully!\n");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
};

runMigration();
