import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("KEYVIA - ADD PUBLIC LISTING REPORTS");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS listing_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id VARCHAR(80) NOT NULL,
        listing_id UUID,
        reporter_id UUID,
        listing_owner_id UUID,
        reason TEXT NOT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'open',
        admin_notes TEXT,
        reviewed_by UUID,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listing_reports_product_id
      ON listing_reports(product_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listing_reports_status_created
      ON listing_reports(status, created_at DESC);
    `);

    await client.query("COMMIT");

    console.log("Listing reports table is ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();
