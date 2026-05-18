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
  console.log("KEYVIA - VERIFICATION HISTORY TABLE");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS verification_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        changed_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        old_status VARCHAR(40),
        new_status VARCHAR(40) NOT NULL,
        old_is_verified BOOLEAN,
        new_is_verified BOOLEAN NOT NULL DEFAULT false,
        rejection_reason TEXT,
        source VARCHAR(80) DEFAULT 'admin_review',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verification_history_user
        ON verification_history(user_id, created_at DESC);
    `);

    await client.query("COMMIT");
    console.log("✓ verification_history table created");
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
