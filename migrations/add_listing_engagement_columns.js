// migrations/add_listing_engagement_columns.js

import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Adding listing engagement columns...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
      ADD COLUMN IF NOT EXISTS views_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS saves_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS shares_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS contact_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tour_request_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS current_viewers INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_views_count
      ON listings (views_count DESC);

      CREATE INDEX IF NOT EXISTS idx_listings_saves_count
      ON listings (saves_count DESC);

      CREATE INDEX IF NOT EXISTS idx_listings_shares_count
      ON listings (shares_count DESC);

      CREATE INDEX IF NOT EXISTS idx_listings_contact_count
      ON listings (contact_count DESC);

      CREATE INDEX IF NOT EXISTS idx_listings_tour_request_count
      ON listings (tour_request_count DESC);

      CREATE INDEX IF NOT EXISTS idx_listings_current_viewers
      ON listings (current_viewers DESC);

      CREATE INDEX IF NOT EXISTS idx_listings_last_viewed_at
      ON listings (last_viewed_at DESC);
    `);

    await client.query("COMMIT");

    console.log("✅ Listing engagement columns added successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();