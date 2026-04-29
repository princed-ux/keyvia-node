import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("🚀 KEYVIA - ADD RECURRING SUBSCRIPTION FIELDS");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS next_billing_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT,
      ADD COLUMN IF NOT EXISTS provider_customer_id TEXT;
    `);

    await client.query(`
      ALTER TABLE subscription_payments
      ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT,
      ADD COLUMN IF NOT EXISTS provider_customer_id TEXT,
      ADD COLUMN IF NOT EXISTS billing_reason VARCHAR(40) DEFAULT 'initial',
      ADD COLUMN IF NOT EXISTS billing_period_start TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS billing_period_end TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_next_billing_at
      ON users(next_billing_at);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_provider_subscription_id
      ON users(provider_subscription_id);
    `);

    await client.query("COMMIT");

    console.log("✅ Recurring subscription fields added successfully");
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