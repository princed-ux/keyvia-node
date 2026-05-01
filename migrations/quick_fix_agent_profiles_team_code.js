import { pool } from "../db.js";

async function run() {
  try {
    console.log("🔧 Fixing agent_profiles missing team_code...");

    await pool.query(`
      ALTER TABLE agent_profiles
      ADD COLUMN IF NOT EXISTS team_code VARCHAR(40),
      ADD COLUMN IF NOT EXISTS linked_agency_id UUID,
      ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS license_number VARCHAR(120),
      ADD COLUMN IF NOT EXISTS experience_years INTEGER;
    `);

    const check = await pool.query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_name = 'agent_profiles'
      AND column_name IN (
        'team_code',
        'linked_agency_id',
        'is_solo_agent',
        'license_number',
        'experience_years'
      )
      ORDER BY column_name;
    `);

    console.table(check.rows);

    console.log("✅ agent_profiles team_code fix completed.");
  } catch (err) {
    console.error("❌ agent_profiles fix failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();