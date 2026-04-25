import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA - ADD LISTING RISK + SUBSCRIPTION FIELDS");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
      ADD COLUMN IF NOT EXISTS risk_score INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS risk_level VARCHAR(30) DEFAULT 'low',
      ADD COLUMN IF NOT EXISTS risk_flags JSONB DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(30) DEFAULT 'auto_pending',
      ADD COLUMN IF NOT EXISTS moderation_notes TEXT,
      ADD COLUMN IF NOT EXISTS auto_published BOOLEAN DEFAULT FALSE;
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'inactive',
      ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS free_listing_limit INT DEFAULT 3;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_risk_level
      ON listings(risk_level);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_moderation_status
      ON listings(moderation_status);
    `);

    await client.query("COMMIT");
    console.log("✅ Listing risk + subscription fields added successfully");
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