import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("KEYVIA - OPEN HOUSES SCHEDULING");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS open_houses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        product_id VARCHAR(80) NOT NULL,
        host_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        scheduled_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
        max_attendees INT,
        current_attendees INT NOT NULL DEFAULT 0,
        status VARCHAR(40) NOT NULL DEFAULT 'scheduled',
        location_details TEXT,
        is_virtual BOOLEAN NOT NULL DEFAULT false,
        virtual_meeting_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS open_house_registrations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        open_house_id UUID NOT NULL REFERENCES open_houses(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        status VARCHAR(40) NOT NULL DEFAULT 'registered',
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cancelled_at TIMESTAMPTZ,
        UNIQUE(open_house_id, user_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_open_houses_listing
      ON open_houses(listing_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_open_houses_host
      ON open_houses(host_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_open_houses_date_status
      ON open_houses(scheduled_date, status);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_open_house_registrations_user
      ON open_house_registrations(user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_open_house_registrations_open_house
      ON open_house_registrations(open_house_id);
    `);

    await client.query("COMMIT");
    console.log("Open houses scheduling tables are ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();
