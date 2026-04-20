// migrate-v6.js - Create APM Metrics Table
import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log(
    "🚀 KEYVIA PLATFORM - DATABASE MIGRATION V6\nCreating APM metrics table...\n",
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create APM metrics table for historical tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS apm_metrics (
        id SERIAL PRIMARY KEY,
        request_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        error_rate FLOAT DEFAULT 0,
        avg_response_time FLOAT DEFAULT 0,
        memory_used INTEGER DEFAULT 0,
        memory_total INTEGER DEFAULT 0,
        active_requests INTEGER DEFAULT 0,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ APM metrics table created");

    // Create indexes on APM table
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_apm_timestamp ON apm_metrics(timestamp DESC);
    `);
    console.log("✅ APM indexes created");

    // Create admin audit log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL,
        action VARCHAR(200) NOT NULL,
        target_type VARCHAR(100),
        target_id VARCHAR(100),
        changes JSONB,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ Admin audit log table created");

    // Create index on admin audit log
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_timestamp ON admin_audit_log(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_admin_id ON admin_audit_log(admin_id);
    `);
    console.log("✅ Admin audit log indexes created");

    // Create rate limit stats table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rate_limit_stats (
        id SERIAL PRIMARY KEY,
        user_id UUID,
        endpoint VARCHAR(255) NOT NULL,
        request_count INTEGER DEFAULT 0,
        limit_exceeded BOOLEAN DEFAULT FALSE,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ Rate limit stats table created");

    // Create index on rate limit stats
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rate_limit_user ON rate_limit_stats(user_id);
      CREATE INDEX IF NOT EXISTS idx_rate_limit_timestamp ON rate_limit_stats(timestamp DESC);
    `);
    console.log("✅ Rate limit stats indexes created");

    await client.query("COMMIT");
    console.log("\n✅ Migration V6 completed successfully!\n");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
};

runMigration();
