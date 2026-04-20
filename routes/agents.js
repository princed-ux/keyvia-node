import express from "express";
import { pool } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();

// Middleware: All routes require login
router.use(authenticateToken);

// ==========================================
// 1. DASHBOARD STATS (Top Cards)
// ==========================================
router.get("/stats", async (req, res) => {
  const agentId = req.user.id;

  try {
    const [listRes, activeRes, viewRes, spentRes] = await Promise.all([
      // 1. Total Listings
      pool.query(
        `SELECT COUNT(*)::int as count FROM listings WHERE created_by = $1`,
        [agentId],
      ),

      // 2. Active Listings
      pool.query(
        `SELECT COUNT(*)::int as count FROM listings WHERE created_by = $1 AND status = 'Active'`,
        [agentId],
      ),

      // 3. Total Views
      pool.query(
        `SELECT COALESCE(SUM(view_count), 0)::int as total FROM listings WHERE created_by = $1`,
        [agentId],
      ),

      // 4. Total Invested (Wallet Funding + Direct Payments)
      pool.query(
        `SELECT COALESCE(SUM(amount), 0)::float as total 
         FROM payments 
         WHERE user_id = $1 AND status = 'successful'`,
        [agentId],
      ),
    ]);

    res.json({
      listings: listRes.rows[0].count || 0,
      active: activeRes.rows[0].count || 0,
      views: viewRes.rows[0].total || 0,
      total_spent: spentRes.rows[0].total || 0,
    });
  } catch (err) {
    console.error("Stats Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 2. DAILY FUNDING CHART (Bar Chart)
// ==========================================
router.get("/charts/funding", async (req, res) => {
  const agentId = req.user.id;

  try {
    // Fetch daily sums for the current week (Monday to Sunday)
    const result = await pool.query(
      `SELECT 
         EXTRACT(ISODOW FROM created_at)::int as day_num, -- 1=Mon, 7=Sun
         SUM(amount) as total
       FROM payments
       WHERE user_id = $1 
         AND status = 'successful'
         AND purpose = 'wallet_funding' -- Only count funding, not spending
         AND created_at >= DATE_TRUNC('week', CURRENT_DATE) -- Start of this week
       GROUP BY day_num
       ORDER BY day_num ASC`,
      [agentId],
    );

    // Map DB result (sparse) to full Mon-Sun array [0, 0, 0, 0, 0, 0, 0]
    const weeklyData = Array(7).fill(0);
    result.rows.forEach((row) => {
      // day_num is 1-7, array index is 0-6
      if (row.day_num >= 1 && row.day_num <= 7) {
        weeklyData[row.day_num - 1] = Number(row.total);
      }
    });

    res.json({ data: weeklyData });
  } catch (err) {
    console.error("Funding Chart Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 3. LISTING TYPES CHART (Donut)
// ==========================================
router.get("/charts/types", async (req, res) => {
  const agentId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT property_type, COUNT(*)::int as count 
       FROM listings 
       WHERE created_by = $1 
       GROUP BY property_type`,
      [agentId],
    );

    const labels = result.rows.map((r) => r.property_type || "Other");
    const series = result.rows.map((r) => r.count);

    res.json({
      labels: labels.length ? labels : ["None"],
      series: series.length ? series : [1], // Placeholder if empty
    });
  } catch (err) {
    console.error("Type Chart Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 4. LISTING STATUS CHART (Donut)
// ==========================================
router.get("/charts/status", async (req, res) => {
  const agentId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT status, COUNT(*)::int as count 
       FROM listings 
       WHERE created_by = $1 
       GROUP BY status`,
      [agentId],
    );

    const labels = result.rows.map((r) => r.status || "Unknown");
    const series = result.rows.map((r) => r.count);

    res.json({
      labels: labels.length ? labels : ["None"],
      series: series.length ? series : [1],
    });
  } catch (err) {
    console.error("Status Chart Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 5. RECENT LISTINGS
// ==========================================
router.get("/listings", async (req, res) => {
  const agentId = req.user.id;
  const limit = req.query.limit || 5;

  try {
    const result = await pool.query(
      `SELECT 
         id, title, city, price, status, view_count, images_urls 
       FROM listings 
       WHERE created_by = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [agentId, limit],
    );

    const data = result.rows.map((row) => {
      // Handle images_urls array safely
      let imageUrl = null;
      if (
        row.images_urls &&
        Array.isArray(row.images_urls) &&
        row.images_urls.length > 0
      ) {
        imageUrl = row.images_urls[0];
      }

      return {
        id: row.id,
        title: row.title,
        location: row.city || "Unknown",
        price: Number(row.price),
        status: row.status,
        views: row.view_count || 0,
        image: imageUrl || "https://via.placeholder.com/150",
      };
    });

    res.json(data);
  } catch (err) {
    console.error("Listings Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 6. RECENT TRANSACTIONS (Wallet)
// ==========================================
router.get("/transactions", async (req, res) => {
  const agentId = req.user.id;
  const limit = req.query.limit || 5;

  try {
    // Fetch from 'payments' table
    const result = await pool.query(
      `SELECT 
         id, 
         amount, 
         purpose as type, 
         status, 
         created_at as date 
       FROM payments 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [agentId, limit],
    );

    const data = result.rows.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      // Format readable type
      type:
        row.type === "wallet_funding" ? "Wallet Funding" : "Listing Activation",
      status: row.status,
      date: row.date,
    }));

    res.json(data);
  } catch (err) {
    console.error("Txn Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
