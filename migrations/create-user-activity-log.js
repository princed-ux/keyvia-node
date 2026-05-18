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
  console.log("KEYVIA - USER ACTIVITY LOG TABLE");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_activity_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        action VARCHAR(80) NOT NULL,
        resource_type VARCHAR(60),
        resource_id VARCHAR(120),
        metadata JSONB DEFAULT '{}'::jsonb,
        ip_address VARCHAR(50),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_activity_user
        ON user_activity_log(user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_user_activity_action
        ON user_activity_log(action, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_user_activity_resource
        ON user_activity_log(resource_type, resource_id);
    `);

    await client.query("COMMIT");
    console.log("✓ user_activity_log table created");
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
