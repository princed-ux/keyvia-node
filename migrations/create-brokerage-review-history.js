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
  console.log("KEYVIA - BROKERAGE REVIEW HISTORY TABLE");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_review_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
        product_id VARCHAR(80) NOT NULL,
        old_status VARCHAR(40),
        new_status VARCHAR(40) NOT NULL,
        reviewed_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_review_product
        ON brokerage_review_history(product_id, created_at DESC);
    `);

    await client.query("COMMIT");
    console.log("✓ brokerage_review_history table created");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration().catch(() => process.exit(1));
