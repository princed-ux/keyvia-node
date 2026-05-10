import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("KEYVIA - LIVE TOUR SAFETY FOUNDATION");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE live_tours
      ADD COLUMN IF NOT EXISTS current_viewers INT NOT NULL DEFAULT 0;
    `);

    await client.query(`
      ALTER TABLE live_tours
      ADD COLUMN IF NOT EXISTS total_viewers INT NOT NULL DEFAULT 0;
    `);

    await client.query(`
      ALTER TABLE live_tours
      ADD COLUMN IF NOT EXISTS peak_viewers INT NOT NULL DEFAULT 0;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS live_tour_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tour_id UUID NOT NULL REFERENCES live_tours(id) ON DELETE CASCADE,
        listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
        product_id VARCHAR(80),
        reporter_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        host_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        reason VARCHAR(80) NOT NULL,
        details TEXT,
        status VARCHAR(40) NOT NULL DEFAULT 'pending',
        action_taken TEXT,
        internal_notes TEXT,
        reviewed_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_live_tour_reports_status_created
      ON live_tour_reports(status, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_live_tour_reports_tour
      ON live_tour_reports(tour_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_live_tour_reports_host
      ON live_tour_reports(host_id);
    `);

    await client.query("COMMIT");
    console.log("Live tour safety foundation is ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();
