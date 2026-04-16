import 'dotenv/config'; // Loads your DB credentials from .env
import pkg from 'pg';
const { Pool } = pkg;

// Use your existing environment variables
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Or use host, user, password, etc.
  ssl: {
    rejectUnauthorized: false // Required for AWS RDS connections
  }
});

const runMigration = async () => {
  console.log("🚀 Initializing AWS Database Migration...");
  
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log("Adding Team Code columns...");
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS team_code VARCHAR(20) UNIQUE;
      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS team_code VARCHAR(20) UNIQUE;
    `);

    console.log("Adding Linked Agency relationship columns...");
    // Check if columns exist before adding foreign key constraints to prevent errors
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS linked_agency_id UUID;
      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS linked_agency_id UUID;
    `);

    console.log("Adding Solo Status flags...");
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE;
      ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_solo_agent BOOLEAN DEFAULT TRUE;
    `);

    await client.query('COMMIT');
    console.log("✅ SUCCESS: AWS Database updated with Brokerage/Agency schema.");

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ MIGRATION FAILED:", err.message);
  } finally {
    client.release();
    await pool.end();
    process.exit();
  }
};

runMigration();