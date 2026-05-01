import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Adding team_code and agency relationship fields...");

    await client.query("BEGIN");

    // Users table: main auth/user record
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(40),
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS brokerage_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS brokerage_address TEXT,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    // Brokerage profiles: company-level profile
    await client.query(`
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

    // Agent profiles: agent/brokerage relationship
    await client.query(`
      ALTER TABLE agent_profiles
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    // Profiles table: safe snapshot fields for frontend profile reads
    await client.query(`
      ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(40),
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS brokerage_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS brokerage_address TEXT,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_team_code
      ON users (team_code);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_profiles_team_code
      ON brokerage_profiles (team_code);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_profiles_linked_agency_id
      ON agent_profiles (linked_agency_id);
    `);

    await client.query("COMMIT");

    console.log("✅ team_code and agency fields added successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();