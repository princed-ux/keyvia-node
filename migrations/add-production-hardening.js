import { pool } from "../db.js";

async function up() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Missing FK indexes (query performance under load)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_listing_id
        ON messages(listing_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_applications_buyer_id
        ON applications(buyer_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_s3_uploads_resource_id
        ON s3_uploads(resource_id);
    `);

    // Webhook event deduplication table (idempotency guard for payment providers)
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id           SERIAL PRIMARY KEY,
        provider     TEXT        NOT NULL,
        event_id     TEXT        NOT NULL,
        event_type   TEXT,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_webhook_events UNIQUE (provider, event_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
        ON webhook_events(received_at);
    `);

    await client.query("COMMIT");
    console.log("✅ add-production-hardening migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

up().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
