import { pool } from "../db.js";

async function run() {
  try {
    console.log("🔧 Fixing missing team_code columns...");

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(40),
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS brokerage_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS brokerage_address TEXT,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    await pool.query(`
      ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(40),
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS brokerage_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS brokerage_address TEXT,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    await pool.query(`
      ALTER TABLE brokerage_profiles
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(40),
      ADD COLUMN IF NOT EXISTS brokerage_address TEXT,
      ADD COLUMN IF NOT EXISTS verified_badge BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS billing_status VARCHAR(50) DEFAULT 'inactive',
      ADD COLUMN IF NOT EXISTS listing_limit INTEGER DEFAULT 5,
      ADD COLUMN IF NOT EXISTS agent_limit INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS live_access BOOLEAN DEFAULT FALSE;
    `);

    await pool.query(`
      ALTER TABLE agent_profiles
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    const check = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE column_name = 'team_code'
      ORDER BY table_name;
    `);

    console.table(check.rows);

    console.log("✅ team_code fix completed.");
  } catch (err) {
    console.error("❌ team_code fix failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();