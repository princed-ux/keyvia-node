import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(unique_id) ON DELETE CASCADE,
        role VARCHAR(30) NOT NULL,
        plan VARCHAR(80) NOT NULL,
        provider VARCHAR(40) NOT NULL,
        reference VARCHAR(120) UNIQUE NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'NGN',
        status VARCHAR(30) DEFAULT 'pending',
        checkout_url TEXT,
        provider_response JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        paid_at TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscription_payments_user_id
      ON subscription_payments(user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_subscription_payments_reference
      ON subscription_payments(reference);
    `);

    await client.query("COMMIT");
    console.log("✅ Subscription payments migration completed");
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