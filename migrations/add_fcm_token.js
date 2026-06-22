// keyvia-node/migrations/add_fcm_token.js
// Adds FCM device token storage to the users table.
// Run once: node migrations/add_fcm_token.js

import { pool } from "../db.js";

const up = async () => {
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS fcm_token TEXT;

    CREATE INDEX IF NOT EXISTS idx_users_fcm_token
      ON users (fcm_token)
      WHERE fcm_token IS NOT NULL;
  `);

  console.log("✅ Migration complete: users.fcm_token added");
};

up()
  .catch((err) => {
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  })
  .finally(() => pool.end());
