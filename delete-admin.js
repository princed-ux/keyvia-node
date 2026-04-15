// delete-admin.js
import { pool } from './db.js';

const deleteAdmin = async () => {
  try {
    console.log("🗑️ Deleting admin account...");
    
    // Delete from profiles first (to avoid any relation conflicts)
    await pool.query(`DELETE FROM profiles WHERE email = 'princederrick100@gmail.com'`);
    
    // Delete from users
    await pool.query(`DELETE FROM users WHERE email = 'princederrick100@gmail.com'`);
    
    console.log("✅ Admin account completely wiped from AWS!");
  } catch (err) {
    console.error("❌ Error deleting account:", err);
  } finally {
    pool.end();
    process.exit();
  }
};

deleteAdmin();