// migrate-v3.js
// ============================================================================
// DATABASE MIGRATION TO ALIGN ENUM VALUES WITH EXPECTED BACKEND VALUES
// Run with: node migrate-v3.js
// ============================================================================

import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA PLATFORM - DATABASE MIGRATION V3");
  console.log("=========================================");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    console.log("✅ Transaction started\n");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: UPDATE ENUM VALUES
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🏷️  Updating ENUM Types...");

    // Update user_role enum to match backend expectations
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum WHERE enumlabel = 'BrokerageOwner' AND enumtypid = 'user_role'::regtype
        ) THEN
          ALTER TYPE user_role ADD VALUE 'BrokerageOwner';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_enum WHERE enumlabel = 'AgencyAgent' AND enumtypid = 'user_role'::regtype
        ) THEN
          ALTER TYPE user_role ADD VALUE 'AgencyAgent';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_enum WHERE enumlabel = 'IndependentAgent' AND enumtypid = 'user_role'::regtype
        ) THEN
          ALTER TYPE user_role ADD VALUE 'IndependentAgent';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_enum WHERE enumlabel = 'Buyer' AND enumtypid = 'user_role'::regtype
        ) THEN
          ALTER TYPE user_role ADD VALUE 'Buyer';
        END IF;
      END $$;
    `);

    console.log("✅ ENUM values updated\n");

    await client.query("COMMIT");
    console.log("✅ Migration completed successfully\n");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
  } finally {
    client.release();
  }
};

runMigration();
