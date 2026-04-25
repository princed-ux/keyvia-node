import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA - ADD LISTING MEDIA PIPELINE FIELDS");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
      ADD COLUMN IF NOT EXISTS media_processing_status VARCHAR(30) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS media_processing_error TEXT,
      ADD COLUMN IF NOT EXISTS video_key TEXT,
      ADD COLUMN IF NOT EXISTS video_public_id TEXT,
      ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS brokerage_review_status VARCHAR(30) DEFAULT 'not_required',
      ADD COLUMN IF NOT EXISTS brokerage_reviewed_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS brokerage_reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS admin_notes TEXT,
      ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'unpaid';
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_agency_id
      ON listings(agency_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_assigned_agent_id
      ON listings(assigned_agent_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_media_processing_status
      ON listings(media_processing_status);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_brokerage_review_status
      ON listings(brokerage_review_status);
    `);

    await client.query("COMMIT");

    console.log("✅ Listing media pipeline fields added successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();