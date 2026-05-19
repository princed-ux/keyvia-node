import { pool } from "../db.js";

export async function up() {
  await pool.query(`
    ALTER TABLE favorites
    ADD COLUMN IF NOT EXISTS product_id TEXT;
  `);

  await pool.query(`
    ALTER TABLE favorites
    ALTER COLUMN listing_id DROP NOT NULL;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_user_product_unique
      ON favorites(user_id, product_id)
      WHERE product_id IS NOT NULL;
  `);
}

export async function down() {
  await pool.query(`
    DROP INDEX IF EXISTS idx_favorites_user_product_unique;
  `);
}

export default { up, down };
