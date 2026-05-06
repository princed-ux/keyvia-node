import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Adding missing listing area columns...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
      ADD COLUMN IF NOT EXISTS building_area_sqft NUMERIC,
      ADD COLUMN IF NOT EXISTS land_area_sqft NUMERIC,
      ADD COLUMN IF NOT EXISTS square_footage NUMERIC;
    `);

    await client.query(`
      UPDATE listings
      SET square_footage = COALESCE(square_footage, building_area_sqft, land_area_sqft)
      WHERE square_footage IS NULL;
    `);

    await client.query("COMMIT");

    console.log("✅ Missing listing area columns added successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to add missing listing area columns:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();