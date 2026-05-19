import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Adding location intelligence and listing history foundations...");
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS formatted_address TEXT,
        ADD COLUMN IF NOT EXISTS place_id TEXT,
        ADD COLUMN IF NOT EXISTS location_confidence VARCHAR(40),
        ADD COLUMN IF NOT EXISTS property_tax_frequency VARCHAR(20) DEFAULT 'yearly',
        ADD COLUMN IF NOT EXISTS insurance_frequency VARCHAR(20) DEFAULT 'yearly',
        ADD COLUMN IF NOT EXISTS estate_service_charge NUMERIC,
        ADD COLUMN IF NOT EXISTS estate_service_charge_frequency VARCHAR(20),
        ADD COLUMN IF NOT EXISTS service_charge_frequency VARCHAR(20);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS location_intelligence_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID NULL,
        product_id TEXT NOT NULL,
        latitude NUMERIC,
        longitude NUMERIC,
        provider VARCHAR(50),
        status VARCHAR(30) DEFAULT 'pending',
        schools JSONB DEFAULT '[]',
        hospitals JSONB DEFAULT '[]',
        transit JSONB DEFAULT '[]',
        groceries_markets JSONB DEFAULT '[]',
        restaurants_cafes JSONB DEFAULT '[]',
        parks_recreation JSONB DEFAULT '[]',
        malls_shopping JSONB DEFAULT '[]',
        lifestyle_summary JSONB DEFAULT '{}',
        street_view JSONB DEFAULT '{}',
        error_message TEXT NULL,
        scanned_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_location_intelligence_product
        ON location_intelligence_snapshots (product_id, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_price_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID NULL,
        product_id TEXT NOT NULL,
        old_price NUMERIC NULL,
        new_price NUMERIC NOT NULL,
        currency VARCHAR(10),
        change_type VARCHAR(40) DEFAULT 'price_update',
        changed_by UUID NULL,
        source VARCHAR(40) DEFAULT 'listing_update',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_listing_price_history_product
        ON listing_price_history (product_id, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_status_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID NULL,
        product_id TEXT NOT NULL,
        old_status VARCHAR(40),
        new_status VARCHAR(40),
        changed_by UUID NULL,
        reason TEXT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_listing_status_history_product
        ON listing_status_history (product_id, created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_engagement_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID NULL,
        product_id TEXT NOT NULL,
        views_count INTEGER DEFAULT 0,
        saves_count INTEGER DEFAULT 0,
        shares_count INTEGER DEFAULT 0,
        contact_count INTEGER DEFAULT 0,
        tour_request_count INTEGER DEFAULT 0,
        snapshot_date DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_engagement_snapshots_daily
        ON listing_engagement_snapshots (product_id, snapshot_date);
    `);

    await client.query("COMMIT");
    console.log("Location intelligence and history foundations are ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Location intelligence/history migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
