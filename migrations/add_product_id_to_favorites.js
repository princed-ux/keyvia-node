import { pool } from "../db.js";

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Adding product_id to favorites...");

    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE favorites
      ADD COLUMN IF NOT EXISTS product_id TEXT;
    `);

    /*
      Backfill product_id if favorites has a listing_id column
      and listings has an id column.
    */
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'favorites'
          AND column_name = 'listing_id'
        )
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'listings'
          AND column_name = 'id'
        )
        THEN
          UPDATE favorites f
          SET product_id = l.product_id
          FROM listings l
          WHERE f.product_id IS NULL
          AND f.listing_id = l.id;
        END IF;
      END $$;
    `);

    /*
      Add index for fast favorite checks.
      This is safe even if your table already has rows.
    */
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_favorites_product_id
      ON favorites(product_id);
    `);

    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'favorites'
          AND column_name = 'user_id'
        )
        THEN
          CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_user_product_unique
          ON favorites(user_id, product_id)
          WHERE product_id IS NOT NULL;
        END IF;
      END $$;
    `);

    await client.query("COMMIT");

    console.log("✅ favorites.product_id added successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Failed to add product_id to favorites:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();