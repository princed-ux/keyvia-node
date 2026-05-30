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

    console.log('Creating app_settings table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        group_name TEXT NOT NULL DEFAULT 'general',
        description TEXT,
        updated_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    console.log('Seeding notification settings...');
    await client.query(`
      INSERT INTO app_settings (key, value, group_name, description) VALUES
        ('notify_admin_new_listing', 'true', 'notifications', 'Notify admins when a new listing enters moderation'),
        ('notify_admin_flagged_listing', 'true', 'notifications', 'Notify admins when a listing is flagged by AI or reports'),
        ('notify_admin_verification_submitted', 'true', 'notifications', 'Notify admins when a user submits verification documents'),
        ('notify_admin_support_escalation', 'true', 'notifications', 'Notify admins when support issues need manual attention')
      ON CONFLICT (key) DO NOTHING
    `);

    console.log('Seeding security settings...');
    await client.query(`
      INSERT INTO app_settings (key, value, group_name, description) VALUES
        ('require_admin_reauth_for_sensitive_actions', 'true', 'security', 'Ask admins to re-authenticate before sensitive actions'),
        ('log_admin_moderation_actions', 'true', 'security', 'Keep audit trail for all moderation actions'),
        ('restrict_private_documents_to_admins', 'true', 'security', 'Restrict verification and legal documents to authorized admins'),
        ('notify_super_admin_on_high_risk_override', 'true', 'security', 'Alert owner when admin overrides high-risk AI result')
      ON CONFLICT (key) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
    process.exit(0);
  }
};

runMigration();
