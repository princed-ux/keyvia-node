// keyvia-node/migrations/add_trusted_devices.js
// Adds the trusted_devices table for device-trust login bypass,
// adds attempts tracking to email_otps (brute-force protection),
// and adds the missing columns to refresh_tokens that settings routes expect.
// Run once: node migrations/add_trusted_devices.js

import { pool } from "../db.js";

const up = async () => {
  await pool.query(`
    -- Trusted devices: stores hashed tokens for skip-OTP login
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      VARCHAR(50) NOT NULL,
      token_hash   TEXT NOT NULL,
      device_label TEXT,
      ip_address   TEXT,
      last_used_at TIMESTAMPTZ,
      expires_at   TIMESTAMPTZ NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_trusted_devices_token_hash
      ON trusted_devices(token_hash);
    CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_id
      ON trusted_devices(user_id);

    -- OTP attempt counter for brute-force protection
    ALTER TABLE email_otps
      ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

    -- Missing columns on refresh_tokens (already read by settings routes)
    ALTER TABLE refresh_tokens
      ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS device_info  TEXT,
      ADD COLUMN IF NOT EXISTS ip_address   TEXT;
  `);

  console.log("✅ Migration complete: trusted_devices, email_otps.attempts, refresh_tokens columns");
};

up()
  .catch((err) => {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
