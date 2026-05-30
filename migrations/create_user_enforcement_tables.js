import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log("Adding user enforcement columns to users table...");
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS flagged_listings_count INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS suspension_history JSONB DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS ai_risk_notes TEXT,
        ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS account_status VARCHAR(50) DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS suspension_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
    `);

    console.log("Creating user_enforcement_logs table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_enforcement_logs (
        id SERIAL PRIMARY KEY,
        target_user_id UUID REFERENCES users(unique_id) ON DELETE CASCADE,
        action VARCHAR(100) NOT NULL,
        reason TEXT,
        admin_id UUID REFERENCES users(unique_id),
        admin_name VARCHAR(255),
        duration VARCHAR(50),
        send_email BOOLEAN DEFAULT FALSE,
        details JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log("Creating indexes for user_enforcement_logs...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_enforcement_target ON user_enforcement_logs (target_user_id);
      CREATE INDEX IF NOT EXISTS idx_user_enforcement_created ON user_enforcement_logs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_enforcement_action ON user_enforcement_logs (action);
    `);

    await client.query('COMMIT');
    console.log("User enforcement migration completed successfully.");
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
};

runMigration();
