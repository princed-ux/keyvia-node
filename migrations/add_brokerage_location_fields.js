import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("Adding brokerage location & contact fields...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE brokerage_profiles
      ADD COLUMN IF NOT EXISTS country VARCHAR(100),
      ADD COLUMN IF NOT EXISTS city VARCHAR(100),
      ADD COLUMN IF NOT EXISTS state VARCHAR(100),
      ADD COLUMN IF NOT EXISTS email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
    `);

    console.log("  - country, city, state, email, phone columns added");

    // Backfill country/city/state from the old brokerages table
    const backfillResult = await client.query(`
      UPDATE brokerage_profiles bp
      SET
        country = COALESCE(bp.country, b.headquarters_country),
        city = COALESCE(bp.city, b.headquarters_city),
        state = COALESCE(bp.state, b.headquarters_state),
        phone = COALESCE(bp.phone, b.phone)
      FROM brokerages b
      WHERE b.owner_id::text = bp.unique_id::text
        AND (
          bp.country IS NULL OR bp.city IS NULL OR
          bp.state IS NULL OR bp.phone IS NULL
        )
    `);

    console.log(`  - backfilled ${backfillResult.rowCount} rows from brokerages table`);

    // Backfill country/city from profiles table (onboarding stores it there)
    await client.query(`
      UPDATE brokerage_profiles bp
      SET
        country = COALESCE(bp.country, p.country),
        city = COALESCE(bp.city, p.city)
      FROM profiles p
      WHERE p.unique_id::text = bp.unique_id::text
        AND (bp.country IS NULL OR bp.city IS NULL)
    `);

    console.log("  - backfilled from profiles table");

    // Backfill logo_url from users.avatar_url (existing logo uploads)
    await client.query(`
      UPDATE brokerage_profiles bp
      SET logo_url = u.avatar_url
      FROM users u
      WHERE u.unique_id::text = bp.unique_id::text
        AND bp.logo_url IS NULL
        AND u.avatar_url IS NOT NULL
    `);

    console.log("  - backfilled logo_url from users.avatar_url");

    // Backfill email from users table
    await client.query(`
      UPDATE brokerage_profiles bp
      SET email = u.email
      FROM users u
      WHERE u.unique_id::text = bp.unique_id::text
        AND bp.email IS NULL
    `);

    console.log("  - backfilled email from users table");

    await client.query("COMMIT");

    console.log("Brokerage location & contact fields added and backfilled.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();
