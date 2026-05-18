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
  console.log("KEYVIA - NOTIFICATION DELIVERY TABLE");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_delivery (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
        recipient_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        channel VARCHAR(20) NOT NULL DEFAULT 'in_app',
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        last_attempt_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notification_delivery_recipient
        ON notification_delivery(recipient_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notification_delivery_status
        ON notification_delivery(status);
    `);

    await client.query("COMMIT");
    console.log("✓ notification_delivery table created");
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
