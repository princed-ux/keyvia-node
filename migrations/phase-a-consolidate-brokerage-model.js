// migrations/phase-a-consolidate-brokerage-model.js
// ============================================================================
// PHASE A — BROKERAGE MODEL CONSOLIDATION
// ----------------------------------------------------------------------------
// The platform has two brokerage models:
//   1. brokerage_profiles (keyed by owner users.unique_id)  <-- CANONICAL, used
//   2. brokerages (id, owner_id)                            <-- retired, 0 rows
//
// agency_id columns on listings / team_messages / live_tours FK to brokerages.id,
// which can never be populated (the real identity is the owner's unique_id).
//
// This migration:
//   1. Safety-checks: brokerages is empty AND all agency_id values are NULL.
//   2. Repoints agency_id FKs from brokerages.id -> users.unique_id.
//   3. Backfills listings.agency_id from the owning brokerage.
//   4. Drops the retired brokerages table.
//
// Fully transactional — any failure rolls back with zero changes.
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

// Tables whose agency_id FK must be repointed to users.unique_id.
const AGENCY_FK_TABLES = ["listings", "team_messages", "live_tours"];

const runMigration = async () => {
  console.log("KEYVIA — PHASE A: BROKERAGE MODEL CONSOLIDATION");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ---- 0. Does the brokerages table even exist? (idempotency) ----
    const tableExists = await client.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='brokerages' LIMIT 1`,
    );
    if (tableExists.rows.length === 0) {
      console.log("✓ brokerages table already gone — nothing to do.");
      await client.query("COMMIT");
      return;
    }

    // ---- 1. SAFETY CHECKS ----
    const brokeragesCount = await client.query(`SELECT COUNT(*)::int AS c FROM brokerages`);
    if (brokeragesCount.rows[0].c !== 0) {
      throw new Error(
        `ABORT: brokerages has ${brokeragesCount.rows[0].c} row(s). ` +
          `Expected 0. Migrate that data before consolidating.`,
      );
    }

    for (const t of AGENCY_FK_TABLES) {
      const exists = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name=$1 AND column_name='agency_id' LIMIT 1`,
        [t],
      );
      if (exists.rows.length === 0) continue;

      const nonNull = await client.query(
        `SELECT COUNT(*)::int AS c FROM ${t} WHERE agency_id IS NOT NULL`,
      );
      if (nonNull.rows[0].c !== 0) {
        throw new Error(
          `ABORT: ${t}.agency_id has ${nonNull.rows[0].c} non-NULL value(s) ` +
            `still pointing at brokerages.id. Manual review required.`,
        );
      }
    }
    console.log("✓ Safety checks passed (brokerages empty, all agency_id NULL).");

    // ---- 2. REPOINT agency_id FKs: brokerages.id -> users.unique_id ----
    for (const t of AGENCY_FK_TABLES) {
      const colExists = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name=$1 AND column_name='agency_id' LIMIT 1`,
        [t],
      );
      if (colExists.rows.length === 0) {
        console.log(`  - ${t}: no agency_id column, skipping`);
        continue;
      }

      // Find and drop any FK on <table>.agency_id (whatever it currently references).
      const fks = await client.query(
        `SELECT tc.constraint_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
         WHERE tc.constraint_type='FOREIGN KEY'
           AND tc.table_name=$1
           AND kcu.column_name='agency_id'`,
        [t],
      );
      for (const row of fks.rows) {
        await client.query(`ALTER TABLE ${t} DROP CONSTRAINT "${row.constraint_name}"`);
        console.log(`  - ${t}: dropped FK ${row.constraint_name}`);
      }

      // Add the corrected FK -> users.unique_id (matches users.linked_agency_id).
      const newName = `${t}_agency_id_users_fkey`;
      await client.query(
        `ALTER TABLE ${t}
         ADD CONSTRAINT "${newName}"
         FOREIGN KEY (agency_id) REFERENCES users(unique_id) ON DELETE SET NULL`,
      );
      console.log(`  - ${t}: added FK ${newName} -> users(unique_id)`);
    }

    // ---- 3. BACKFILL listings.agency_id ----
    // (a) Listings uploaded by a brokerage owner -> that owner's unique_id.
    const b1 = await client.query(
      `UPDATE listings l
       SET agency_id = bp.unique_id
       FROM brokerage_profiles bp
       WHERE l.uploaded_by_id = bp.unique_id
         AND l.agency_id IS NULL`,
    );
    // (b) Listings uploaded by an agency agent -> the agent's linked_agency_id.
    const b2 = await client.query(
      `UPDATE listings l
       SET agency_id = u.linked_agency_id
       FROM users u
       WHERE l.uploaded_by_id = u.unique_id
         AND u.linked_agency_id IS NOT NULL
         AND l.agency_id IS NULL`,
    );
    console.log(`✓ Backfilled listings.agency_id: ${b1.rowCount} owner-owned, ${b2.rowCount} agent-owned.`);

    // ---- 4. DROP the retired brokerages table ----
    await client.query(`DROP TABLE brokerages`);
    console.log("✓ Dropped retired brokerages table.");

    await client.query("COMMIT");
    console.log("✅ Phase A consolidation complete.");
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
