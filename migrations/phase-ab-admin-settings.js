// migrations/phase-ab-admin-settings.js
// ============================================================================
// ADMIN/SUPER-ADMIN PHASE A + B
//  A1: fix admin_audit_log schema drift (add admin_name, ip_address)
//  A2: create feature_flags (with rollout_status)
//  B1: consolidate settings onto platform_settings (single store):
//      - migrate app_settings rows in
//      - seed default rows for every registry key that is missing
// Idempotent + transactional. Existing values (ai_* etc.) are preserved.
// ============================================================================

import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

// Default seeds: [key, value, type]. ON CONFLICT DO NOTHING preserves live values.
const SEED = [
  // platform
  ["maintenance_mode", "false", "boolean"],
  ["allow_new_registrations", "true", "boolean"],
  ["default_currency", "USD", "text"],
  ["max_listings_per_user", "0", "number"],
  ["platform_fee_percent", "0", "number"],
  ["platform_fee_cap", "0", "number"],
  ["free_listing_limit", "1", "number"],
  // moderation & AI (already present in prod, kept for fresh envs)
  ["ai_auto_scan_listings", "true", "boolean"],
  ["ai_auto_scan_verifications", "true", "boolean"],
  ["ai_auto_approve_low_risk", "false", "boolean"],
  ["ai_auto_reject_high_risk", "false", "boolean"],
  ["ai_require_manual_review_medium_risk", "true", "boolean"],
  // notifications (admin alerts)
  ["notify_admin_new_listing", "true", "boolean"],
  ["notify_admin_flagged_listing", "true", "boolean"],
  ["notify_admin_verification_submitted", "true", "boolean"],
  ["notify_admin_support_escalation", "true", "boolean"],
  // security
  ["require_admin_reauth_for_sensitive_actions", "false", "boolean"],
  ["log_admin_moderation_actions", "true", "boolean"],
  ["restrict_private_documents_to_admins", "true", "boolean"],
  ["notify_super_admin_on_high_risk_override", "true", "boolean"],
  // registration & verification
  ["require_kyc", "false", "boolean"],
];

const run = async () => {
  console.log("KEYVIA — ADMIN PHASE A+B MIGRATION");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- A1: admin_audit_log schema drift ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL,
        action VARCHAR(100) NOT NULL,
        target_type VARCHAR(80),
        target_id VARCHAR(120),
        changes JSONB,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS admin_name VARCHAR(200)`);
    await client.query(`ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit_log(timestamp DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_log(admin_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action)`);
    console.log("✓ admin_audit_log columns + indexes ready (admin_name, ip_address).");

    // --- A2: feature_flags (with rollout_status) ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(100) UNIQUE NOT NULL,
        label VARCHAR(200) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        rollout_status VARCHAR(30) NOT NULL DEFAULT 'off',
        description TEXT,
        updated_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE feature_flags ADD COLUMN IF NOT EXISTS rollout_status VARCHAR(30) NOT NULL DEFAULT 'off'`);
    console.log("✓ feature_flags table ready (with rollout_status).");

    // --- B1: consolidate settings onto platform_settings ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        type VARCHAR(40) NOT NULL DEFAULT 'text',
        description TEXT,
        updated_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Migrate any app_settings rows into platform_settings (preserve values).
    const appExists = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='app_settings' LIMIT 1`,
    );
    if (appExists.rows.length) {
      const moved = await client.query(`
        INSERT INTO platform_settings (key, value, type, description)
        SELECT key, value, 'boolean', description FROM app_settings
        ON CONFLICT (key) DO NOTHING
      `);
      console.log(`✓ Migrated ${moved.rowCount} row(s) from app_settings -> platform_settings.`);
    }

    // Seed defaults for any missing registry keys (existing values untouched).
    let seeded = 0;
    for (const [key, value, type] of SEED) {
      const r = await client.query(
        `INSERT INTO platform_settings (key, value, type) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO NOTHING`,
        [key, value, type],
      );
      seeded += r.rowCount;
    }
    console.log(`✓ Seeded ${seeded} missing default setting(s).`);

    await client.query("COMMIT");
    console.log("✅ Admin Phase A+B migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed (rolled back):", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

run().catch(() => process.exit(1));
