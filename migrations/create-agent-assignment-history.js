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
  console.log("KEYVIA - AGENT ASSIGNMENT HISTORY TABLE");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_assignment_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
        product_id VARCHAR(80) NOT NULL,
        old_agent_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        new_agent_id UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        assigned_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        reason VARCHAR(200),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_agent_assignment_product
        ON agent_assignment_history(product_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_agent_assignment_agent
        ON agent_assignment_history(new_agent_id, created_at DESC);
    `);

    await client.query("COMMIT");
    console.log("✓ agent_assignment_history table created");
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
