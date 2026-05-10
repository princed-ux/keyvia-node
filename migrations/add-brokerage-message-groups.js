import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Adding brokerage team message groups...");

    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_message_groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brokerage_id UUID NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        avatar_url TEXT,
        is_default BOOLEAN DEFAULT FALSE,
        created_by UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_message_group_members (
        group_id UUID NOT NULL REFERENCES brokerage_message_groups(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        is_admin BOOLEAN DEFAULT FALSE,
        member_role TEXT DEFAULT 'member',
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (group_id, user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_message_group_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES brokerage_message_groups(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL,
        message TEXT NOT NULL,
        attachment_url TEXT,
        attachment_type TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_brokerage_message_groups_default
      ON brokerage_message_groups (brokerage_id)
      WHERE is_default = TRUE;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_message_groups_brokerage
      ON brokerage_message_groups (brokerage_id, updated_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_message_group_members_user
      ON brokerage_message_group_members (user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_message_group_messages_group
      ON brokerage_message_group_messages (group_id, created_at ASC);
    `);

    await client.query("COMMIT");

    console.log("Brokerage team message groups are ready.");
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
