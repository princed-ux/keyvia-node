import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Adding agency messaging settings, reports, and read receipts...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS product_id TEXT;
    `);

    await client.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS product_id TEXT,
      ADD COLUMN IF NOT EXISTS attachment_url TEXT,
      ADD COLUMN IF NOT EXISTS attachment_type TEXT,
      ADD COLUMN IF NOT EXISTS is_auto_reply BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_settings (
        user_id UUID PRIMARY KEY,
        auto_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        auto_reply_template TEXT NOT NULL DEFAULT 'Thanks for your interest! I am away right now and will get back to you shortly.',
        away_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        away_schedule JSONB NOT NULL DEFAULT '{"mode":"always","timezone":"Africa/Lagos","start_time":"18:00","end_time":"09:00","days":[0,1,2,3,4,5,6]}'::jsonb,
        quick_replies JSONB NOT NULL DEFAULT '[]'::jsonb,
        property_quick_replies JSONB NOT NULL DEFAULT '[]'::jsonb,
        auto_greeting_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        auto_follow_up_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_message_group_reads (
        group_id UUID NOT NULL REFERENCES brokerage_message_groups(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (group_id, user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID,
        group_id UUID,
        message_id TEXT,
        reporter_id UUID NOT NULL,
        reported_user_id UUID,
        reason_type TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_auto_reply_logs (
        conversation_id UUID NOT NULL,
        responder_id UUID NOT NULL,
        requester_id UUID NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (conversation_id, responder_id, requester_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER NOT NULL,
        user_id UUID NOT NULL,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_product_id
      ON conversations(product_id);

      CREATE INDEX IF NOT EXISTS idx_messages_product_id
      ON messages(product_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_group_reads_user
      ON brokerage_message_group_reads(user_id);

      CREATE INDEX IF NOT EXISTS idx_message_reports_reporter
      ON message_reports(reporter_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_message_reports_conversation
      ON message_reports(conversation_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_auto_reply_logs_request
      ON message_auto_reply_logs(requester_id, sent_at DESC);
    `);

    await client.query("COMMIT");

    console.log("Agency messaging tables are ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
