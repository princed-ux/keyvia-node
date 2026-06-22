import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Applying Phase B messaging schema updates...");

    await client.query("BEGIN");

    // Message editing support
    await client.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    `);

    // Soft delete support
    await client.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    `);

    // Conversation archiving per user
    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS archived_by_user1 BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS archived_by_user2 BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // Conversation type for filtering and routing
    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS conversation_type TEXT NOT NULL DEFAULT 'direct'
        CHECK (conversation_type IN ('direct','listing_inquiry','lead','tour_request','support'));
    `);

    // Full-text search index on message content
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_fts
        ON messages USING GIN (to_tsvector('english', COALESCE(message, '')));
    `);

    // Index to support soft-delete filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_deleted_at
        ON messages (deleted_at)
        WHERE deleted_at IS NULL;
    `);

    // Index to support conversation_type filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_type
        ON conversations (conversation_type);
    `);

    await client.query("COMMIT");
    console.log("Phase B messaging schema migration complete.");
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
