import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 Adding listing ownership compatibility columns...");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS created_by UUID,
        ADD COLUMN IF NOT EXISTS agent_unique_id UUID;
    `);

    await client.query(`
      UPDATE listings
      SET
        created_by = COALESCE(created_by, uploaded_by_id),
        agent_unique_id = COALESCE(agent_unique_id, uploaded_by_id)
      WHERE uploaded_by_id IS NOT NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_created_by ON listings(created_by);
      CREATE INDEX IF NOT EXISTS idx_listings_agent_unique_id ON listings(agent_unique_id);
    `);

    await client.query("COMMIT");

    console.log("✅ Listing ownership compatibility columns ready");
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