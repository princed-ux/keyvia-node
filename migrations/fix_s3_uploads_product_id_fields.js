import { pool } from "../db.js";

async function run() {
  try {
    console.log("🔧 Fixing s3_uploads product/listing ID fields...");

    await pool.query(`
      ALTER TABLE s3_uploads
      ADD COLUMN IF NOT EXISTS product_id VARCHAR(80),
      ADD COLUMN IF NOT EXISTS draft_listing_id VARCHAR(80),
      ADD COLUMN IF NOT EXISTS listing_uuid UUID;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_s3_uploads_product_id
      ON s3_uploads(product_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_s3_uploads_draft_listing_id
      ON s3_uploads(draft_listing_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_s3_uploads_listing_uuid
      ON s3_uploads(listing_uuid);
    `);

    const check = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 's3_uploads'
      AND column_name IN (
        'resource_id',
        'product_id',
        'draft_listing_id',
        'listing_uuid'
      )
      ORDER BY column_name;
    `);

    console.table(check.rows);

    console.log("✅ s3_uploads ID fields fixed.");
  } catch (err) {
    console.error("❌ s3_uploads fix failed:", err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();