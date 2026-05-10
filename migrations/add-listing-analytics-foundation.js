import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Adding listing analytics foundation...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS views_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS saves_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS shares_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS contact_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tour_request_count INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS previous_price NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS price_drop_amount NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS price_drop_percent NUMERIC(8,2),
        ADD COLUMN IF NOT EXISTS last_price_drop_at TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_view_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id TEXT NOT NULL,
        viewer_id TEXT,
        viewer_hash TEXT,
        user_agent_hash TEXT,
        viewed_on DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_view_events_unique_daily
        ON listing_view_events (
          product_id,
          viewed_on,
          COALESCE(viewer_id, ''),
          COALESCE(viewer_hash, '')
        );

      CREATE INDEX IF NOT EXISTS idx_listing_view_events_product
        ON listing_view_events (product_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_listing_view_events_viewer
        ON listing_view_events (viewer_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_listings_engagement_counts
        ON listings (views_count, saves_count, shares_count);
    `);

    await client.query(`
      UPDATE listings l
      SET saves_count = favorite_counts.count
      FROM (
        SELECT product_id, COUNT(*)::int AS count
        FROM favorites
        GROUP BY product_id
      ) favorite_counts
      WHERE l.product_id = favorite_counts.product_id
        AND COALESCE(l.saves_count, 0) <> favorite_counts.count;
    `);

    await client.query("COMMIT");
    console.log("Listing analytics foundation is ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Listing analytics migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
