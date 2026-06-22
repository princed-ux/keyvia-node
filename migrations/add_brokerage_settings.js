// keyvia-node/migrations/add_brokerage_settings.js
// Expands brokerage_profiles with branding/settings columns,
// creates brokerage_office_locations and brokerage_licenses tables,
// and adds AI call tracking columns to users.
// Run once: node migrations/add_brokerage_settings.js

import { pool } from "../db.js";

const up = async () => {
  await pool.query(`
    -- ── brokerage_profiles: new branding + settings columns ──────────────────
    ALTER TABLE brokerage_profiles
      ADD COLUMN IF NOT EXISTS cover_image_url        TEXT,
      ADD COLUMN IF NOT EXISTS brand_color            VARCHAR(7),
      ADD COLUMN IF NOT EXISTS bio                    TEXT,
      ADD COLUMN IF NOT EXISTS phone                  VARCHAR(30),
      ADD COLUMN IF NOT EXISTS social_links           JSONB DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS business_hours         JSONB DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS analytics_preferences  JSONB DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS lead_routing_rules     JSONB DEFAULT '{}';

    -- ── Multiple office locations per brokerage ───────────────────────────────
    CREATE TABLE IF NOT EXISTS brokerage_office_locations (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brokerage_id VARCHAR(50) NOT NULL,
      label        TEXT NOT NULL,
      address      TEXT,
      city         VARCHAR(100),
      state        VARCHAR(100),
      country      VARCHAR(100) DEFAULT 'Nigeria',
      phone        VARCHAR(30),
      is_primary   BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_office_locations_brokerage
      ON brokerage_office_locations(brokerage_id);

    -- ── License management per brokerage ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS brokerage_licenses (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      brokerage_id   VARCHAR(50) NOT NULL,
      license_type   VARCHAR(100),
      license_number VARCHAR(100) NOT NULL,
      issuing_body   TEXT,
      issue_date     DATE,
      expiry_date    DATE,
      is_active      BOOLEAN DEFAULT TRUE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_licenses_brokerage
      ON brokerage_licenses(brokerage_id);

    -- ── AI call tracking (daily quota per user) ───────────────────────────────
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS ai_calls_today    INT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS ai_calls_reset_at TIMESTAMPTZ;
  `);

  console.log("✅ Migration complete: brokerage settings columns, office_locations, licenses, ai_calls");
};

up()
  .catch((err) => {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
