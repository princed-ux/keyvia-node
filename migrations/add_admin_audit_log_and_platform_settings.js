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

    console.log("Adding missing columns to admin_audit_log...");
    await client.query(`
      ALTER TABLE admin_audit_log
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS admin_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS target_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);
    `);

    console.log("Adding platform settings columns...");
    await client.query(`
      ALTER TABLE platform_settings
        ADD COLUMN IF NOT EXISTS maintenance_mode BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS allow_new_registrations BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS require_kyc BOOLEAN DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS max_listings_per_user INTEGER DEFAULT 50,
        ADD COLUMN IF NOT EXISTS default_currency VARCHAR(10) DEFAULT 'USD',
        ADD COLUMN IF NOT EXISTS platform_fee_percent NUMERIC(5,2) DEFAULT 2.50,
        ADD COLUMN IF NOT EXISTS platform_fee_cap NUMERIC(12,2) DEFAULT 500.00,
        ADD COLUMN IF NOT EXISTS free_listing_limit INTEGER DEFAULT 5;
    `);

    console.log("Creating index on admin_audit_log...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action ON admin_audit_log (action);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_id ON admin_audit_log (admin_id);
    `);

    await client.query('COMMIT');
    console.log("Migration completed successfully.");
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
