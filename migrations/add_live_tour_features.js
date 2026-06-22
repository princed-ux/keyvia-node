// keyvia-node/migrations/add_live_tour_features.js
// ============================================================================
// Live Tour Phase 2-16: Comments, Reactions, Follow, Scheduled Tours, Thumbnails
// Run: node migrations/add_live_tour_features.js
// ============================================================================
import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const run = async () => {
  console.log("KEYVIA — Live Tour Features Migration");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ─── live_tours enhancements ────────────────────────────────────────────
    await client.query(`
      ALTER TABLE live_tours
        ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
        ADD COLUMN IF NOT EXISTS scheduled_at  TIMESTAMPTZ;
    `);

    // ─── live_tour_comments ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS live_tour_comments (
        id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
        tour_id     UUID      NOT NULL REFERENCES live_tours(id) ON DELETE CASCADE,
        user_id     UUID      NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        user_name   TEXT,
        user_avatar TEXT,
        message     TEXT      NOT NULL CHECK (char_length(message) BETWEEN 1 AND 500),
        is_deleted  BOOLEAN   NOT NULL DEFAULT FALSE,
        deleted_by  UUID      REFERENCES users(unique_id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_live_comments_tour
        ON live_tour_comments(tour_id, created_at DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_live_comments_user
        ON live_tour_comments(user_id);
    `);

    // ─── live_tour_reactions ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS live_tour_reactions (
        id            UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
        tour_id       UUID      NOT NULL REFERENCES live_tours(id) ON DELETE CASCADE,
        user_id       UUID      NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        reaction_type VARCHAR(20) NOT NULL
          CHECK (reaction_type IN ('like','love','fire','clap','house','interest')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(tour_id, user_id, reaction_type)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_live_reactions_tour
        ON live_tour_reactions(tour_id);
    `);

    // ─── user_follows ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_follows (
        id           UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
        follower_id  UUID      NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        following_id UUID      NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(follower_id, following_id),
        CONSTRAINT no_self_follow CHECK (follower_id != following_id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_follows_follower
        ON user_follows(follower_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_follows_following
        ON user_follows(following_id);
    `);

    await client.query("COMMIT");
    console.log("✅ Live tour features migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

run();
