import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Adding listing draft/autosave fields...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
      ADD COLUMN IF NOT EXISTS current_step VARCHAR(80),
      ADD COLUMN IF NOT EXISTS draft_data JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS autosaved_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS legal_visibility VARCHAR(30) DEFAULT 'private',
      ADD COLUMN IF NOT EXISTS legal_review_status VARCHAR(30) DEFAULT 'not_submitted',
      ADD COLUMN IF NOT EXISTS title_public_summary JSONB DEFAULT '{}'::jsonb;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_uploaded_by_status
      ON listings(uploaded_by_id, status);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_product_id_status
      ON listings(product_id, status);
    `);

    await client.query("COMMIT");

    console.log("✅ Listing draft/autosave fields added successfully.");
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