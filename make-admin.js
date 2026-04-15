import { pool } from "./db.js";

const makeAdmin = async () => {
  try {
    console.log("Connecting to AWS RDS...");

    const result = await pool.query(`
      UPDATE users 
      SET role = 'admin', 
          is_admin = TRUE, 
          is_super_admin = FALSE, -- Keeps them as a regular Admin/Moderator
          verification_status = 'verified'
      WHERE email = 'official.rixade@gmail.com'
      RETURNING email, role, is_admin, is_super_admin;
    `);

    if (result.rowCount === 0) {
      console.log(
        "⚠️ No user found with that email! Make sure official.rixade@gmail.com has signed up on the frontend first.",
      );
    } else {
      console.log("✅ SUCCESS! User promoted to REGULAR Admin (Moderator):");
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