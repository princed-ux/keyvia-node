import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("KEYVIA - ADD NOTIFICATION FOUNDATION FIELDS");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        recipient_id UUID,
        type TEXT DEFAULT 'system',
        title TEXT NOT NULL,
        message TEXT,
        entity_type TEXT,
        entity_id TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE notifications
        DROP CONSTRAINT IF EXISTS valid_type;

      ALTER TABLE notifications
        ADD COLUMN IF NOT EXISTS user_id UUID,
        ADD COLUMN IF NOT EXISTS receiver_id UUID,
        ADD COLUMN IF NOT EXISTS sender_id UUID,
        ADD COLUMN IF NOT EXISTS product_id TEXT,
        ADD COLUMN IF NOT EXISTS entity_type TEXT,
        ADD COLUMN IF NOT EXISTS entity_id TEXT,
        ADD COLUMN IF NOT EXISTS resource_type TEXT,
        ADD COLUMN IF NOT EXISTS resource_id TEXT,
        ADD COLUMN IF NOT EXISTS related_resource_type TEXT,
        ADD COLUMN IF NOT EXISTS related_resource_id TEXT,
        ADD COLUMN IF NOT EXISTS action_url TEXT,
        ADD COLUMN IF NOT EXISTS action_label TEXT,
        ADD COLUMN IF NOT EXISTS link TEXT,
        ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'notifications'
            AND column_name = 'related_resource_id'
            AND data_type <> 'text'
        ) THEN
          ALTER TABLE notifications
            ALTER COLUMN related_resource_id TYPE TEXT
            USING related_resource_id::text;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'notifications'
            AND column_name = 'resource_id'
            AND data_type <> 'text'
        ) THEN
          ALTER TABLE notifications
            ALTER COLUMN resource_id TYPE TEXT
            USING resource_id::text;
        END IF;
      END $$;
    `);

    await client.query(`
      UPDATE notifications
      SET
        receiver_id = COALESCE(receiver_id, recipient_id, user_id),
        user_id = COALESCE(user_id, recipient_id, receiver_id),
        recipient_id = COALESCE(recipient_id, receiver_id, user_id),
        entity_type = COALESCE(entity_type, related_resource_type, resource_type),
        entity_id = COALESCE(entity_id, related_resource_id, product_id, resource_id::text),
        action_url = COALESCE(action_url, link),
        link = COALESCE(link, action_url),
        data = COALESCE(data, '{}'::jsonb),
        is_read = COALESCE(is_read, false),
        updated_at = COALESCE(updated_at, created_at, NOW())
      WHERE true;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_recipient_id
        ON notifications(recipient_id);

      CREATE INDEX IF NOT EXISTS idx_notifications_receiver_id
        ON notifications(receiver_id);

      CREATE INDEX IF NOT EXISTS idx_notifications_user_id
        ON notifications(user_id);

      CREATE INDEX IF NOT EXISTS idx_notifications_unread
        ON notifications(is_read);

      CREATE INDEX IF NOT EXISTS idx_notifications_created_at
        ON notifications(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notifications_entity
        ON notifications(entity_type, entity_id);
    `);

    await client.query("COMMIT");
    console.log("Notification foundation migration completed successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Notification foundation migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();
