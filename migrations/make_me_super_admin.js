// migrations/make_me_super_admin.js

import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

const ADMIN_EMAIL = "aniela.michaela@minafter.com";
const ADMIN_ROLE = "super_admin"; // change to "admin" if you only want normal admin

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production" || process.env.DATABASE_URL?.includes("amazonaws.com")
      ? { rejectUnauthorized: false }
      : false,
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log("🚀 Making user admin...");
    console.log(`📧 Email: ${ADMIN_EMAIL}`);
    console.log(`🛡️ Role: ${ADMIN_ROLE}`);

    await client.query("BEGIN");

    const userCheck = await client.query(
      `
      SELECT id, email, role
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
      `,
      [ADMIN_EMAIL],
    );

    if (userCheck.rowCount === 0) {
      throw new Error(`No user found with email: ${ADMIN_EMAIL}`);
    }

    const user = userCheck.rows[0];

    console.log("👤 Found user:", {
      id: user.id,
      email: user.email,
      current_role: user.role,
    });

    await client.query(
      `
      UPDATE users
      SET
        role = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [ADMIN_ROLE, user.id],
    );

    // Optional safety update only if profiles table has a role column.
    const profileRoleColumn = await client.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'profiles'
        AND column_name = 'role'
      LIMIT 1
      `,
    );

    if (profileRoleColumn.rowCount > 0) {
      await client.query(
        `
        UPDATE profiles
        SET role = $1
        WHERE user_id = $2
        `,
        [ADMIN_ROLE, user.id],
      );

      console.log("✅ profiles.role also updated.");
    } else {
      console.log("ℹ️ profiles.role column not found. Skipped profile role update.");
    }

    await client.query("COMMIT");

    const updated = await client.query(
      `
      SELECT id, email, role, updated_at
      FROM users
      WHERE id = $1
      `,
      [user.id],
    );

    console.log("✅ Admin role updated successfully:");
    console.table(updated.rows);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();