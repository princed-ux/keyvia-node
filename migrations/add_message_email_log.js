import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Creating message_email_log table for threshold-based email gating...");

    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_email_log (
        user_id UUID NOT NULL,
        threshold_key TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reset_at TIMESTAMPTZ,
        PRIMARY KEY (user_id, threshold_key)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_message_email_log_user_id
        ON message_email_log (user_id);
    `);

    await client.query("COMMIT");
    console.log("message_email_log migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

runMigration().catch((err) => {
  console.error(err);
  process.exit(1);
});