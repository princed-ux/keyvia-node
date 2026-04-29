import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 Adding visibility field to s3_uploads...");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE s3_uploads
      ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) DEFAULT 'public';
    `);

    await client.query(`
      ALTER TABLE s3_uploads
      DROP CONSTRAINT IF EXISTS s3_uploads_visibility_check;
    `);

    await client.query(`
      ALTER TABLE s3_uploads
      ADD CONSTRAINT s3_uploads_visibility_check
      CHECK (visibility IN ('public', 'semi-public', 'private'));
    `);

    await client.query("COMMIT");

    console.log("✅ visibility field added to s3_uploads");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();