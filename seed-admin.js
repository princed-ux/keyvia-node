// seed-admin.js
import { pool } from './db.js';
import bcrypt from 'bcrypt';

const seedAdmin = async () => {
  const client = await pool.connect();
  try {
    console.log("🚀 Starting Super Admin Seed...");
    
    // 1. Details for your Master Account
    const name = "Prince Derrick";
    const email = "princederrick100@gmail.com";
    const password = "kolade123"; // You can change this
    const role = "superadmin";

    // 2. Hash the password exactly like your auth.js does
    const hashedPassword = await bcrypt.hash(password, 10);

    await client.query('BEGIN');

    // 3. Insert into USERS table
    const userRes = await client.query(
      `INSERT INTO users (
        name, email, password, role, is_verified, 
        is_super_admin, is_admin, phone_verified, verification_status
      ) 
      VALUES ($1, $2, $3, $4, true, true, true, true, 'verified')
      ON CONFLICT (email) DO NOTHING
      RETURNING unique_id, special_id`,
      [name, email, hashedPassword, role]
    );

    let unique_id;
    let special_id;

    if (userRes.rows.length > 0) {
        unique_id = userRes.rows[0].unique_id;
        special_id = userRes.rows[0].special_id || "ADMIN-001";
        
        // 4. Update the special_id if it was null
        await client.query(`UPDATE users SET special_id = $1 WHERE unique_id = $2`, [special_id, unique_id]);

        // 5. Insert into PROFILES table to prevent "user not found" errors later
        await client.query(
          `INSERT INTO profiles (
            unique_id, email, full_name, role, special_id, verification_status, is_admin, is_super_admin
          )
          VALUES ($1, $2, $3, $4, $5, 'verified', true, true)
          ON CONFLICT (unique_id) DO NOTHING`,
          [unique_id, email, name, role, special_id]
        );

        console.log("✅ Super Admin successfully created in AWS!");
        console.log(`📧 Email: ${email}`);
        console.log(`🔑 Password: ${password}`);
    } else {
        console.log("⚠️ Super Admin email already exists in the database.");
    }

    await client.query('COMMIT');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("❌ Error seeding database:", err);
  } finally {
    client.release();
    pool.end();
    process.exit();
  }
};

seedAdmin();