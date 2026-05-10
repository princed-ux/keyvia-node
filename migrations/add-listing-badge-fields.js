import "dotenv/config";
import pkg from "pg";

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const runMigration = async () => {
  console.log("KEYVIA - ADD LISTING BADGE FIELDS");

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE listings
        ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS is_featured BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS featured_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS is_showcase BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS showcase_until TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS previous_price NUMERIC(14,2);
    `);

    const dateColumnResult = await client.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'listings'
        AND column_name = ANY($1)
      `,
      [["listed_at", "activated_at", "created_at"]],
    );
    const dateColumns = ["listed_at", "activated_at", "created_at"].filter(
      (column) => dateColumnResult.rows.some((row) => row.column_name === column),
    );

    if (dateColumns.length) {
      await client.query(`
        UPDATE listings
        SET published_at = COALESCE(published_at, ${dateColumns.join(", ")})
        WHERE published_at IS NULL
          AND status = 'approved';
      `);
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_published_at
        ON listings(published_at);

      CREATE INDEX IF NOT EXISTS idx_listings_featured_until
        ON listings(featured_until);

      CREATE INDEX IF NOT EXISTS idx_listings_showcase_until
        ON listings(showcase_until);

      CREATE INDEX IF NOT EXISTS idx_listings_badge_flags
        ON listings(is_featured, is_showcase);
    `);

    await client.query("COMMIT");
    console.log("Listing badge fields migration completed successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Listing badge fields migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration();
