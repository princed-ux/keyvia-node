// migrations/create_message_settings_table.js

import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});


async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Creating message_settings table...");

    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

        user_id UUID NOT NULL UNIQUE,

        -- Privacy / availability
        allow_message_requests BOOLEAN NOT NULL DEFAULT TRUE,
        allow_unknown_users BOOLEAN NOT NULL DEFAULT TRUE,
        show_online_status BOOLEAN NOT NULL DEFAULT TRUE,
        show_last_seen BOOLEAN NOT NULL DEFAULT TRUE,
        show_typing_indicator BOOLEAN NOT NULL DEFAULT TRUE,
        read_receipts BOOLEAN NOT NULL DEFAULT TRUE,

        -- Notifications
        push_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        desktop_notifications BOOLEAN NOT NULL DEFAULT TRUE,
        sound_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        message_preview BOOLEAN NOT NULL DEFAULT TRUE,

        -- Safety / filtering
        mute_unknown_senders BOOLEAN NOT NULL DEFAULT FALSE,
        block_media_from_unknown BOOLEAN NOT NULL DEFAULT FALSE,

        -- Quiet hours
        do_not_disturb BOOLEAN NOT NULL DEFAULT FALSE,
        quiet_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        quiet_hours_start TIME,
        quiet_hours_end TIME,

        -- Flexible future settings
        extra_settings JSONB NOT NULL DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_message_settings_user_id
      ON message_settings(user_id);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION set_message_settings_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS trg_message_settings_updated_at
      ON message_settings;
    `);

    await client.query(`
      CREATE TRIGGER trg_message_settings_updated_at
      BEFORE UPDATE ON message_settings
      FOR EACH ROW
      EXECUTE FUNCTION set_message_settings_updated_at();
    `);

    /**
     * Backfill settings for existing users.
     * This supports both schemas:
     * - users.unique_id
     * - users.id
     */
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'users'
          AND column_name = 'unique_id'
        ) THEN
          INSERT INTO message_settings (user_id)
          SELECT unique_id
          FROM users
          WHERE unique_id IS NOT NULL
          ON CONFLICT (user_id) DO NOTHING;

        ELSIF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'users'
          AND column_name = 'id'
        ) THEN
          INSERT INTO message_settings (user_id)
          SELECT id
          FROM users
          WHERE id IS NOT NULL
          ON CONFLICT (user_id) DO NOTHING;
        END IF;
      END $$;
    `);

    await client.query("COMMIT");

    console.log("✅ message_settings table created successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to create message_settings table:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();