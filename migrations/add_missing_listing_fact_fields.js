import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Adding missing listing fact fields...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
      ADD COLUMN IF NOT EXISTS year_built INTEGER,
      ADD COLUMN IF NOT EXISTS total_rooms INTEGER,
      ADD COLUMN IF NOT EXISTS property_condition VARCHAR(80),
      ADD COLUMN IF NOT EXISTS construction_status VARCHAR(80),
      ADD COLUMN IF NOT EXISTS ownership_type VARCHAR(120),
      ADD COLUMN IF NOT EXISTS parking VARCHAR(120),
      ADD COLUMN IF NOT EXISTS square_footage NUMERIC,
      ADD COLUMN IF NOT EXISTS lot_size NUMERIC,
      ADD COLUMN IF NOT EXISTS area_sqft NUMERIC,
      ADD COLUMN IF NOT EXISTS land_area_sqft NUMERIC,
      ADD COLUMN IF NOT EXISTS building_area_unit VARCHAR(20) DEFAULT 'sqft',
      ADD COLUMN IF NOT EXISTS land_area_unit VARCHAR(20) DEFAULT 'sqft';
    `);

    await client.query("COMMIT");

    console.log("✅ Missing listing fact fields added successfully.");
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