import { pool } from "../db.js";

export async function up() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brokerage_projects (
      id BIGSERIAL PRIMARY KEY,
      brokerage_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      location VARCHAR(255),
      status VARCHAR(50) NOT NULL DEFAULT 'planning',
      project_type VARCHAR(100),
      total_units INTEGER,
      available_units INTEGER,
      assigned_agent_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_brokerage_projects_brokerage_id
      ON brokerage_projects (brokerage_id);
  `);
}

export async function down() {
  await pool.query("DROP TABLE IF EXISTS brokerage_projects;");
}

export default { up, down };
