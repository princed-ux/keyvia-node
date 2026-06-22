// middleware/ensureProfile.js
import { pool } from "../db.js";

export const ensureProfile = async (req, res, next) => {
  try {
    const { unique_id, email, name, role } = req.user;

    await pool.query(`
      INSERT INTO profiles (unique_id, email, full_name, role_snapshot)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (unique_id) DO NOTHING
    `, [unique_id, email, name, role]);

    next();
  } catch (err) {
    console.error("ensureProfile error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};