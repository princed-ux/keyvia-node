import { pool } from "./db.js";

const makeAdmin = async () => {
  try {
    console.log("Connecting to AWS RDS...");

    const result = await pool.query(`
      UPDATE users
      SET role = 'admin',
          is_admin = TRUE,
          is_super_admin = FALSE,
          verification_status = 'verified',
          is_verified = TRUE
      WHERE LOWER(email) = LOWER('official.rixade@gmail.com')
      RETURNING email, role, is_admin, is_super_admin, verification_status;
    `);

    if (result.rowCount === 0) {
      console.log(
        "⚠️ No user found with that email. Make sure official.rixade@gmail.com already exists in users."
      );
    } else {
      console.log("✅ SUCCESS! User promoted to regular Admin:");
      console.log(result.rows[0]);
    }
  } catch (error) {
    console.error("❌ Error making admin:", error);
  } finally {
    await pool.end();
    process.exit();
  }
};

makeAdmin();