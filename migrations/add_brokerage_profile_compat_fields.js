import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Adding brokerage/profile compatibility fields...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS brokerage_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS brokerage_address TEXT,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    await client.query(`
      ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS brokerage_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS brokerage_address TEXT,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    await client.query(`
      ALTER TABLE agent_profiles
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(40),
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    await client.query(`
      ALTER TABLE brokerage_profiles
      ADD COLUMN IF NOT EXISTS company_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS brokerage_address TEXT,
      ADD COLUMN IF NOT EXISTS registration_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(40),
      ADD COLUMN IF NOT EXISTS verified_badge BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS billing_status VARCHAR(50) DEFAULT 'inactive',
      ADD COLUMN IF NOT EXISTS listing_limit INTEGER DEFAULT 5,
      ADD COLUMN IF NOT EXISTS agent_limit INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS live_access BOOLEAN DEFAULT FALSE;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_linked_agency_id
      ON users (linked_agency_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_profiles_linked_agency_id
      ON agent_profiles (linked_agency_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_profiles_team_code
      ON brokerage_profiles (team_code);
    `);

    await client.query(`
      UPDATE brokerage_profiles bp
      SET
        company_name = COALESCE(bp.company_name, u.brokerage_name, u.name),
        brokerage_address = COALESCE(bp.brokerage_address, u.brokerage_address),
        registration_number = COALESCE(bp.registration_number, u.license_number)
      FROM users u
      WHERE bp.unique_id::text = u.unique_id::text;
    `);

    await client.query("COMMIT");

    console.log("Brokerage/profile compatibility fields added.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
