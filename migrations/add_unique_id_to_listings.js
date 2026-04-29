import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const runMigration = async () => {
  console.log("🚀 Adding unique_id to listings...");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
      ADD COLUMN IF NOT EXISTS unique_id UUID;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_unique_id
      ON listings(unique_id);
    `);

    await client.query("COMMIT");

    console.log("✅ unique_id added to listings");
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