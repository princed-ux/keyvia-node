import { pool } from "../db.js";

export async function up() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_profile_views (
      id BIGSERIAL PRIMARY KEY,
      profile_owner_id TEXT NOT NULL,
      viewer_id TEXT NULL,
      viewer_role TEXT NULL,
      source TEXT NOT NULL DEFAULT 'public_profile',
      viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_public_profile_views_owner_viewed
      ON public_profile_views (profile_owner_id, viewed_at DESC);
  `);
}

export async function down() {
  await pool.query("DROP TABLE IF EXISTS public_profile_views;");
}

export default { up, down };
