import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Creating admin_groups tables (versioned migration)...");

    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_by UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_group_members (
        group_id UUID NOT NULL REFERENCES admin_groups(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (group_id, user_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_group_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id UUID NOT NULL REFERENCES admin_groups(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        attachment_url TEXT,
        attachment_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_group_messages_group_id
        ON admin_group_messages (group_id, created_at DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_group_members_user_id
        ON admin_group_members (user_id);
    `);

    await client.query("COMMIT");
    console.log("admin_groups migration complete.");
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
