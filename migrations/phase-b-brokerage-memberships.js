// migrations/phase-b-brokerage-memberships.js
// ============================================================================
// PHASE B — BROKERAGE MEMBERSHIP WORKFLOW
// ----------------------------------------------------------------------------
// Introduces an explicit request lifecycle for agency agents joining a
// brokerage: pending -> approved | rejected, plus removed.
//
//   - brokerage_id / agent_id are owner/agent users.unique_id (canonical model).
//   - linked_agency_id (on users) remains the "approved member" signal, so all
//     existing dashboard logic keeps working unchanged for approved agents.
//   - This table tracks the request state the brokerage acts on.
//
// Backfills an 'approved' row for every agent already linked to a brokerage,
// so the memberships table is the single source of truth going forward.
// ============================================================================

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
  console.log("KEYVIA — PHASE B: BROKERAGE MEMBERSHIPS");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS brokerage_memberships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brokerage_id UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        agent_id     UUID NOT NULL REFERENCES users(unique_id) ON DELETE CASCADE,
        status       VARCHAR(20) NOT NULL DEFAULT 'pending',
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at   TIMESTAMPTZ,
        decided_by   UUID REFERENCES users(unique_id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT brokerage_memberships_status_chk
          CHECK (status IN ('pending','approved','rejected','removed')),
        CONSTRAINT brokerage_memberships_unique UNIQUE (brokerage_id, agent_id)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_brokerage_memberships_brokerage
        ON brokerage_memberships(brokerage_id, status);
      CREATE INDEX IF NOT EXISTS idx_brokerage_memberships_agent
        ON brokerage_memberships(agent_id, status);
    `);
    console.log("✓ brokerage_memberships table ready.");

    // Backfill: every currently-linked agent is an approved member.
    const backfill = await client.query(`
      INSERT INTO brokerage_memberships (brokerage_id, agent_id, status, requested_at, decided_at)
      SELECT linked_agency_id, unique_id, 'approved', COALESCE(created_at, NOW()), NOW()
      FROM users
      WHERE linked_agency_id IS NOT NULL
      ON CONFLICT (brokerage_id, agent_id) DO NOTHING
    `);
    console.log(`✓ Backfilled ${backfill.rowCount} approved membership(s) from existing links.`);

    await client.query("COMMIT");
    console.log("✅ Phase B migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed (rolled back):", err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

runMigration().catch(() => process.exit(1));
