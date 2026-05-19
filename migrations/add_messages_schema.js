// migrations/add_messages_schema.js

import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Adding/fixing Keyvia messaging schema...");

    await client.query("BEGIN");

    await client.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    `);

    // =========================
    // DIRECT CONVERSATIONS
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
    `);

    await client.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS user1_id UUID,
      ADD COLUMN IF NOT EXISTS user2_id UUID,
      ADD COLUMN IF NOT EXISTS product_id TEXT,
      ADD COLUMN IF NOT EXISTS deleted_by_user1 BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS deleted_by_user2 BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_user1_id
      ON conversations (user1_id);

      CREATE INDEX IF NOT EXISTS idx_conversations_user2_id
      ON conversations (user2_id);

      CREATE INDEX IF NOT EXISTS idx_conversations_product_id
      ON conversations (product_id);

      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations (updated_at DESC);
    `);

    // =========================
    // DIRECT MESSAGES
    // Existing messages table may already exist, so we ALTER it safely.
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id BIGSERIAL PRIMARY KEY
      );
    `);

    await client.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS conversation_id UUID,
      ADD COLUMN IF NOT EXISTS sender_id UUID,
      ADD COLUMN IF NOT EXISTS message TEXT,
      ADD COLUMN IF NOT EXISTS seen BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS product_id TEXT,
      ADD COLUMN IF NOT EXISTS attachment_url TEXT,
      ADD COLUMN IF NOT EXISTS attachment_type TEXT,
      ADD COLUMN IF NOT EXISTS is_auto_reply BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
      ON messages (conversation_id);

      CREATE INDEX IF NOT EXISTS idx_messages_sender_id
      ON messages (sender_id);

      CREATE INDEX IF NOT EXISTS idx_messages_product_id
      ON messages (product_id);

      CREATE INDEX IF NOT EXISTS idx_messages_seen
      ON messages (seen);

      CREATE INDEX IF NOT EXISTS idx_messages_created_at
      ON messages (created_at DESC);
    `);

    // =========================
    // BLOCKED USERS
    // Used before sending messages.
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID NOT NULL,
        blocked_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(blocker_id, blocked_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker_id
      ON blocked_users (blocker_id);

      CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_id
      ON blocked_users (blocked_id);
    `);

    // =========================
    // MESSAGE REACTIONS
    // Used by GET /api/messages/:conversationId
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        message_id BIGINT NOT NULL,
        user_id UUID NOT NULL,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(message_id, user_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id
      ON message_reactions (message_id);
    `);

    // =========================
    // MESSAGE REPORTS
    // Used by POST /api/messages/:conversationId/report
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL,
        message_id TEXT,
        reporter_id UUID NOT NULL,
        reported_user_id UUID NOT NULL,
        reason_type TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_message_reports_conversation_id
      ON message_reports (conversation_id);

      CREATE INDEX IF NOT EXISTS idx_message_reports_reporter_id
      ON message_reports (reporter_id);

      CREATE INDEX IF NOT EXISTS idx_message_reports_reported_user_id
      ON message_reports (reported_user_id);

      CREATE INDEX IF NOT EXISTS idx_message_reports_status
      ON message_reports (status);
    `);

    // =========================
    // BROKERAGE TEAM GROUPS
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_message_groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
    `);

    await client.query(`
      ALTER TABLE brokerage_message_groups
      ADD COLUMN IF NOT EXISTS brokerage_id UUID,
      ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Team Group',
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS avatar_url TEXT,
      ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS created_by UUID,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_message_groups_brokerage_id
      ON brokerage_message_groups (brokerage_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_message_groups_is_default
      ON brokerage_message_groups (is_default);

      CREATE INDEX IF NOT EXISTS idx_brokerage_message_groups_updated_at
      ON brokerage_message_groups (updated_at DESC);
    `);

    // =========================
    // BROKERAGE GROUP MEMBERS
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_message_group_members (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
    `);

    await client.query(`
      ALTER TABLE brokerage_message_group_members
      ADD COLUMN IF NOT EXISTS group_id UUID,
      ADD COLUMN IF NOT EXISTS user_id UUID,
      ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS member_role TEXT NOT NULL DEFAULT 'member',
      ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_brokerage_group_member
      ON brokerage_message_group_members (group_id, user_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_group_members_group_id
      ON brokerage_message_group_members (group_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_group_members_user_id
      ON brokerage_message_group_members (user_id);
    `);

    // =========================
    // BROKERAGE GROUP MESSAGES
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_message_group_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
    `);

    await client.query(`
      ALTER TABLE brokerage_message_group_messages
      ADD COLUMN IF NOT EXISTS group_id UUID,
      ADD COLUMN IF NOT EXISTS sender_id UUID,
      ADD COLUMN IF NOT EXISTS message TEXT,
      ADD COLUMN IF NOT EXISTS attachment_url TEXT,
      ADD COLUMN IF NOT EXISTS attachment_type TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_group_messages_group_id
      ON brokerage_message_group_messages (group_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_group_messages_sender_id
      ON brokerage_message_group_messages (sender_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_group_messages_created_at
      ON brokerage_message_group_messages (created_at DESC);
    `);

    // =========================
    // BROKERAGE GROUP READS
    // =========================
    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_message_group_reads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      );
    `);

    await client.query(`
      ALTER TABLE brokerage_message_group_reads
      ADD COLUMN IF NOT EXISTS group_id UUID,
      ADD COLUMN IF NOT EXISTS user_id UUID,
      ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_brokerage_group_read
      ON brokerage_message_group_reads (group_id, user_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_group_reads_group_id
      ON brokerage_message_group_reads (group_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_group_reads_user_id
      ON brokerage_message_group_reads (user_id);

      CREATE INDEX IF NOT EXISTS idx_brokerage_group_reads_last_read_at
      ON brokerage_message_group_reads (last_read_at DESC);
    `);

    await client.query("COMMIT");

    console.log("✅ Keyvia messaging schema fixed successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Messaging schema migration failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();