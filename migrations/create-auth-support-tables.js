import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA - CREATE AUTH SUPPORT TABLES");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_otps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(150) NOT NULL,
        code_hash TEXT NOT NULL,
        purpose VARCHAR(50) DEFAULT 'signup',
        used BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_otps_email
      ON email_otps(email);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_otps_email_purpose_used
      ON email_otps(email, purpose, used);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS phone_otps (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(30) NOT NULL,
        code_hash TEXT NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_phone_otps_phone
      ON phone_otps(phone);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_phone_otps_phone_used
      ON phone_otps(phone, used);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
      ON refresh_tokens(user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token
      ON refresh_tokens(token);
    `);

    await client.query("COMMIT");

    console.log("✅ Auth support tables created successfully");
    console.log("   - email_otps");
    console.log("   - phone_otps");
    console.log("   - refresh_tokens");
    console.log("🚀 Migration completed!");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Auth support migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();