import express from "express";
import { pool } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";
const router = express.Router();

// 1. Search Users
router.get("/search", authenticateToken, async (req, res) => {
  const query = req.query.query || "";
  const q = `%${query}%`;

  try {
    const requesterRole = String(req.user?.role || "").toLowerCase();
    const isAdmin = requesterRole === "admin" || requesterRole === "super_admin" || requesterRole === "superadmin" || req.user?.is_admin || req.user?.is_super_admin;

    // Non-admin users must never see admin/super_admin accounts in search results
    const adminFilter = isAdmin ? "" : `AND u.role NOT IN ('admin', 'super_admin', 'superadmin')`;

    const { rows } = await pool.query(
      `SELECT u.id, u.name AS full_name, u.unique_id, u.special_id, u.email,
              p.username, p.avatar_url
       FROM users u
       LEFT JOIN profiles p ON p.unique_id = u.unique_id
       WHERE (
         u.name ILIKE $1
          OR p.username ILIKE $1
          OR u.unique_id::text ILIKE $1
          OR u.special_id::text ILIKE $1
       )
       ${adminFilter}
       ORDER BY u.name ASC
       LIMIT 20`,
      [q]
    );
    res.json(rows);
  } catch (err) {
    console.error("Search Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 2. Get User Profile
router.get("/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (String(req.user.unique_id) !== id && !req.user.is_admin && !req.user.is_super_admin) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name AS full_name, u.email, u.unique_id, u.special_id,
              p.username, p.avatar_url
       FROM users u
       LEFT JOIN profiles p ON p.unique_id = u.unique_id
       WHERE u.unique_id = $1 OR u.special_id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Get User Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 3. Last Seen
router.get("/last-seen/:id", authenticateToken, async (req, res) => {
  try {
    const q = await pool.query(
      "SELECT last_active FROM users WHERE unique_id = $1",
      [req.params.id]
    );
    return res.json({ last_active: q.rows[0]?.last_active });
  } catch (err) {
    console.error("Last Seen Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 4. Register / update FCM device token
router.post("/device-token", authenticateToken, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== "string" || token.trim().length < 10) {
    return res.status(400).json({ error: "Valid FCM token required" });
  }
  try {
    await pool.query(
      `UPDATE users SET fcm_token = $1 WHERE unique_id = $2`,
      [token.trim(), req.user.unique_id],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("Device token error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// 5. Block User
router.post("/block", authenticateToken, async (req, res) => {
  const blocker_id = req.user.unique_id;
  const { blocked_id } = req.body;
  if (!blocked_id) return res.status(400).json({ error: "Missing blocked_id" });
  if (blocker_id === blocked_id) return res.status(400).json({ error: "Cannot block yourself" });

  try {
    await pool.query(
      "INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [blocker_id, blocked_id]
    );
    res.json({ success: true, message: "User blocked" });
  } catch (err) {
    console.error("Block User Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 5. Unblock User (✅ ADDED THIS ROUTE)
router.post("/unblock", authenticateToken, async (req, res) => {
  const blocker_id = req.user.unique_id;
  const { blocked_id } = req.body;
  if (!blocked_id) return res.status(400).json({ error: "Missing blocked_id" });

  try {
    await pool.query(
      "DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2",
      [blocker_id, blocked_id]
    );
    res.json({ success: true, message: "User unblocked" });
  } catch (err) {
    console.error("Unblock User Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;