import { pool } from "../db.js";

export async function up() {
  await pool.query(`
    ALTER TABLE listings
    ADD COLUMN IF NOT EXISTS project_id BIGINT;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_listings_project_id
      ON listings (project_id);
  `);
}

export async function down() {
  await pool.query(`
    DROP INDEX IF EXISTS idx_listings_project_id;
  `);

  await pool.query(`
    ALTER TABLE listings
    DROP COLUMN IF EXISTS project_id;
  `);
}

export default { up, down };
