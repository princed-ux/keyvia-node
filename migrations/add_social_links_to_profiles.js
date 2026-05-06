import dotenv from "dotenv";
import { pool } from "../db.js";

dotenv.config();

const migrationName = "add_social_links_to_profiles";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log(`🚀 Running migration: ${migrationName}`);

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE profiles
      ADD COLUMN IF NOT EXISTS social_instagram TEXT,
      ADD COLUMN IF NOT EXISTS social_facebook TEXT,
      ADD COLUMN IF NOT EXISTS social_twitter TEXT,
      ADD COLUMN IF NOT EXISTS social_linkedin TEXT,
      ADD COLUMN IF NOT EXISTS social_tiktok TEXT;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_profiles_social_instagram
      ON profiles (LOWER(social_instagram))
      WHERE social_instagram IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_profiles_social_facebook
      ON profiles (LOWER(social_facebook))
      WHERE social_facebook IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_profiles_social_twitter
      ON profiles (LOWER(social_twitter))
      WHERE social_twitter IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_profiles_social_linkedin
      ON profiles (LOWER(social_linkedin))
      WHERE social_linkedin IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_profiles_social_tiktok
      ON profiles (LOWER(social_tiktok))
      WHERE social_tiktok IS NOT NULL;
    `);

    await client.query("COMMIT");

    console.log(`✅ Migration completed: ${migrationName}`);
  } catch (err) {
    await client.query("ROLLBACK");

    console.error(`❌ Migration failed: ${migrationName}`);
    console.error(err);

    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();