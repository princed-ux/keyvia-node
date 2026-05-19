import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA - ADD LISTING TYPE SPECIFIC FIELDS (short-let, lease)");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log("📌 Adding short-let specific fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS nightly_rate NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS min_stay INTEGER,
        ADD COLUMN IF NOT EXISTS max_stay INTEGER,
        ADD COLUMN IF NOT EXISTS cleaning_fee NUMERIC(14,2);
    `);

    console.log("📌 Adding lease-specific fields...");
    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS lease_deposit NUMERIC(14,2),
        ADD COLUMN IF NOT EXISTS lease_term_months INTEGER,
        ADD COLUMN IF NOT EXISTS lease_type VARCHAR(50);
    `);

    console.log("📌 Creating indexes for new fields...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_nightly_rate
      ON listings(nightly_rate);

      CREATE INDEX IF NOT EXISTS idx_listings_min_stay
      ON listings(min_stay);

      CREATE INDEX IF NOT EXISTS idx_listings_max_stay
      ON listings(max_stay);

      CREATE INDEX IF NOT EXISTS idx_listings_cleaning_fee
      ON listings(cleaning_fee);

      CREATE INDEX IF NOT EXISTS idx_listings_lease_type
      ON listings(lease_type);

      CREATE INDEX IF NOT EXISTS idx_listings_lease_term_months
      ON listings(lease_term_months);
    `);

    await client.query("COMMIT");

    console.log("✅ Listing type specific fields migration completed successfully");
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
