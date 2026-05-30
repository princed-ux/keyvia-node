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

    console.log("Creating platform_visits table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_visits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        visitor_id VARCHAR(64) NOT NULL,
        page VARCHAR(255),
        referrer TEXT,
        user_agent TEXT,
        ip_address VARCHAR(45),
        visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    console.log("Creating indexes for platform_visits...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_visits_visitor_id ON platform_visits (visitor_id);
      CREATE INDEX IF NOT EXISTS idx_platform_visits_visited_at ON platform_visits (visited_at DESC);
      CREATE INDEX IF NOT EXISTS idx_platform_visits_date ON platform_visits (DATE(visited_at));
    `);

    console.log("Adding views_count index to listings...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_views_count ON listings (views_count DESC NULLS LAST);
    `);

    await client.query('COMMIT');
    console.log("Super admin dashboard migration completed successfully.");
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
