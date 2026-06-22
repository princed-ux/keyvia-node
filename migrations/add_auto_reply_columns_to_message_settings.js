import { pool } from "../db.js";

// Ensures message_settings has all auto-reply columns regardless of which
// migration created the table first (create_message_settings_table.js vs
// add-messaging-agency-features.js use different schemas).
async function runMigration() {
  const client = await pool.connect();
  try {
    console.log("Adding auto-reply columns to message_settings...");
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE message_settings
      ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS auto_reply_template TEXT NOT NULL DEFAULT
        'Thanks for your interest! I am away right now and will get back to you shortly.',
      ADD COLUMN IF NOT EXISTS away_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS away_schedule JSONB NOT NULL DEFAULT
        '{"mode":"always","timezone":"Africa/Lagos","start_time":"18:00","end_time":"09:00","days":[0,1,2,3,4,5,6]}'::jsonb,
      ADD COLUMN IF NOT EXISTS quick_replies JSONB NOT NULL DEFAULT
        '["Thanks for your interest. I will get back to you shortly.","This property is still available. Would you like to schedule a viewing?"]'::jsonb,
      ADD COLUMN IF NOT EXISTS property_quick_replies JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS auto_greeting_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS auto_follow_up_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    await client.query("COMMIT");
    console.log("auto-reply columns added successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

runMigration().catch((err) => {
  console.error(err);
  process.exit(1);
});
