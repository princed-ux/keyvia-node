import express from "express";
import { pool } from "../db.js";
import { authenticateToken, requireRole } from "../middleware/authMiddleware.js";
import { requireAnalytics } from "../middleware/planMiddleware.js";

const router = express.Router();

router.use(authenticateToken);
router.use(requireRole("owner"));

// ==========================================
// 1. OWNER STATS
// ==========================================
router.get("/stats", requireAnalytics("basic"), async (req, res) => {
  const ownerId = req.user.unique_id; 

  try {
    const [propRes, tenantRes, revRes] = await Promise.all([
      // 1. Total Properties
      pool.query(`SELECT COUNT(*)::int as count FROM listings WHERE agent_unique_id = $1`, [ownerId]),
      
      // 2. Active Tenants (Assuming 'Occupied' status tracks this)
      pool.query(`SELECT COUNT(*)::int as count FROM listings WHERE agent_unique_id = $1 AND status = 'Occupied'`, [ownerId]),
      
      // 3. Total Revenue (Removed 'purpose' filter to fix crash)
      pool.query(
        `SELECT COALESCE(SUM(amount), 0)::float as total 
         FROM payments 
         WHERE agent_unique_id = $1 AND status = 'successful'`,
        [ownerId]
      )
    ]);

    res.json({
      properties: propRes.rows[0].count || 0,
      tenants: tenantRes.rows[0].count || 0,
      revenue: revRes.rows[0].total || 0,
      maintenance: 0 
    });
  } catch (err) {
    console.error("Owner Stats Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 2. REVENUE CHART (Monthly Rent)
// ==========================================
router.get("/charts/revenue", async (req, res) => {
  const ownerId = req.user.unique_id;

  try {
    const result = await pool.query(
      `SELECT 
          EXTRACT(MONTH FROM created_at)::int as month_num,
          SUM(amount) as total
        FROM payments
        WHERE agent_unique_id = $1 
          AND status = 'successful'
          -- Removed 'purpose' filter here too
          AND created_at >= NOW() - INTERVAL '6 months'
        GROUP BY month_num
        ORDER BY month_num ASC`,
      [ownerId]
    );

    // Ensure we return data for the frontend chart
    const data = result.rows.map(r => Number(r.total));
    res.json({ data: data.length ? data : [0,0,0,0,0,0] });
  } catch (err) {
    console.error("Revenue Chart Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 3. OCCUPANCY CHART (Unchanged)
// ==========================================
router.get("/charts/occupancy", async (req, res) => {
  const ownerId = req.user.unique_id;

  try {
    const result = await pool.query(
      `SELECT status, COUNT(*)::int as count 
       FROM listings 
       WHERE agent_unique_id = $1 
       GROUP BY status`, 
      [ownerId]
    );

    const occupied = result.rows.find(r => r.status === 'Occupied')?.count || 0;
    // Group 'Vacant' and 'Active' together as vacancies
    const vacant = result.rows.find(r => r.status === 'Vacant' || r.status === 'Active')?.count || 0;

    res.json({
      series: [occupied, vacant],
      labels: ["Occupied", "Vacant"]
    });
  } catch (err) {
    console.error("Occupancy Chart Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 4. RECENT PROPERTIES (Unchanged)
// ==========================================
router.get("/properties", async (req, res) => {
  const ownerId = req.user.unique_id;
  const limit = req.query.limit || 5;

  try {
    const result = await pool.query(
      `SELECT id, title, city as location, price as rent, status 
       FROM listings 
       WHERE agent_unique_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [ownerId, limit]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Properties Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 5. RECENT ACTIVITY (Mixed)
// ==========================================
router.get("/activity", async (req, res) => {
  const ownerId = req.user.unique_id;
  
  try {
    // Removed 'purpose' filter
    const result = await pool.query(
      `SELECT 
          id as transaction_id, 
          'Payment' as type, 
          'Rent Received' as message, 
          amount, 
          created_at as date 
        FROM payments 
        WHERE agent_unique_id = $1 
        ORDER BY created_at DESC 
        LIMIT 5`,
      [ownerId]
    );

    const data = result.rows.map(row => ({
      ...row,
      date: new Date(row.date).toLocaleDateString()
    }));

    res.json(data);
  } catch (err) {
    console.error("Activity Error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ==========================================
// 6. FULL ANALYTICS
// ==========================================
router.get("/analytics", requireAnalytics("advanced"), async (req, res) => {
  const ownerId = req.user.unique_id;

  // listings owned by this user
  const ownerWhere = `(
    l.agent_unique_id::text = $1
    OR l.uploaded_by_id::text = $1
    OR l.created_by::text = $1
  )`;

  try {
    const [totalRes, monthlyRes, listingsRes, typesRes, statusRes, funnelRes, dowRes] = await Promise.all([
      // Totals
      pool.query(
        `SELECT
          COUNT(*)::int AS listings,
          COUNT(*) FILTER (WHERE COALESCE(is_active, false) = true AND LOWER(COALESCE(status::text,'')) IN ('approved','live','published','active'))::int AS active,
          COALESCE(SUM(COALESCE(views_count,0)),0)::int AS views,
          COALESCE(SUM(COALESCE(saves_count,0)),0)::int AS saves,
          COALESCE(SUM(COALESCE(contact_count,0)),0)::int AS contacts,
          COALESCE(SUM(COALESCE(tour_request_count,0)),0)::int AS tour_requests,
          COALESCE(SUM(COALESCE(shares_count,0)),0)::int AS shares
        FROM listings l WHERE ${ownerWhere}`,
        [ownerId],
      ),
      // 12-month monthly trend
      pool.query(
        `SELECT
          TO_CHAR(DATE_TRUNC('month', l.created_at), 'YYYY-MM') AS month,
          COUNT(*)::int AS listings_added,
          COALESCE(SUM(COALESCE(l.views_count,0)),0)::int AS views,
          COALESCE(SUM(COALESCE(l.saves_count,0)),0)::int AS saves,
          COALESCE(SUM(COALESCE(l.contact_count,0)),0)::int AS contacts
        FROM listings l
        WHERE ${ownerWhere}
          AND l.created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
        GROUP BY DATE_TRUNC('month', l.created_at)
        ORDER BY month ASC`,
        [ownerId],
      ),
      // Per-listing breakdown (top 20 by views)
      pool.query(
        `SELECT
          l.product_id, l.title,
          l.price, l.currency, l.listing_type, l.property_type,
          l.city, l.state,
          COALESCE(l.views_count,0)::int AS views,
          COALESCE(l.saves_count,0)::int AS saves,
          COALESCE(l.contact_count,0)::int AS contacts,
          COALESCE(l.tour_request_count,0)::int AS tour_requests,
          l.status, l.is_active, l.created_at
        FROM listings l
        WHERE ${ownerWhere}
        ORDER BY COALESCE(l.views_count,0) DESC
        LIMIT 20`,
        [ownerId],
      ),
      // By property type
      pool.query(
        `SELECT COALESCE(NULLIF(l.property_type::text,''),'Other') AS label, COUNT(*)::int AS count
        FROM listings l WHERE ${ownerWhere}
        GROUP BY label ORDER BY count DESC`,
        [ownerId],
      ),
      // By status
      pool.query(
        `SELECT
          CASE
            WHEN COALESCE(l.is_active,false) = true AND LOWER(COALESCE(l.status::text,'')) IN ('approved','live','published','active') THEN 'Live'
            WHEN LOWER(COALESCE(l.status::text,'')) = 'approved' THEN 'Approved'
            WHEN LOWER(COALESCE(l.status::text,'')) = 'pending' THEN 'In Review'
            WHEN LOWER(COALESCE(l.status::text,'')) = 'rejected' THEN 'Needs Fixes'
            WHEN LOWER(COALESCE(l.status::text,'')) = 'draft' THEN 'Draft'
            ELSE 'Unknown'
          END AS label, COUNT(*)::int AS count
        FROM listings l WHERE ${ownerWhere}
        GROUP BY label ORDER BY count DESC`,
        [ownerId],
      ),
      // Engagement funnel (Elite) — conversion rates per listing
      pool.query(
        `SELECT
          COALESCE(SUM(COALESCE(views_count,0)),0)::int AS total_views,
          COALESCE(SUM(COALESCE(saves_count,0)),0)::int AS total_saves,
          COALESCE(SUM(COALESCE(contact_count,0)),0)::int AS total_contacts,
          COALESCE(SUM(COALESCE(tour_request_count,0)),0)::int AS total_tours,
          AVG(COALESCE(views_count,0))::float AS avg_views,
          AVG(COALESCE(saves_count,0))::float AS avg_saves,
          AVG(COALESCE(contact_count,0))::float AS avg_contacts
        FROM listings l WHERE ${ownerWhere}`,
        [ownerId],
      ),
      // Day-of-week: which day listings created get most engagement (Elite)
      pool.query(
        `SELECT
          TO_CHAR(l.created_at, 'Dy') AS day,
          EXTRACT(DOW FROM l.created_at)::int AS day_num,
          COUNT(*)::int AS listings,
          COALESCE(SUM(COALESCE(l.views_count,0)),0)::int AS views,
          COALESCE(SUM(COALESCE(l.contact_count,0)),0)::int AS contacts
        FROM listings l
        WHERE ${ownerWhere}
        GROUP BY day, day_num
        ORDER BY day_num`,
        [ownerId],
      ),
    ]);

    const total = totalRes.rows[0] || {};
    const funnelRow = funnelRes.rows[0] || {};
    const views = Number(total.views || 0);
    const saves = Number(total.saves || 0);
    const contacts = Number(total.contacts || 0);
    const tours = Number(total.tour_requests || 0);

    return res.json({
      success: true,
      analytics: {
        total: {
          listings: total.listings || 0,
          active: total.active || 0,
          views,
          saves,
          contacts,
          tour_requests: tours,
          shares: total.shares || 0,
        },
        monthly: monthlyRes.rows.map((r) => ({
          month: r.month,
          listings_added: Number(r.listings_added || 0),
          views: Number(r.views || 0),
          saves: Number(r.saves || 0),
          contacts: Number(r.contacts || 0),
        })),
        byListing: listingsRes.rows.map((r) => ({
          product_id: r.product_id,
          title: r.title || "Untitled",
          views: Number(r.views || 0),
          saves: Number(r.saves || 0),
          contacts: Number(r.contacts || 0),
          tour_requests: Number(r.tour_requests || 0),
          price: r.price,
          currency: r.currency,
          listing_type: r.listing_type,
          property_type: r.property_type,
          city: r.city,
          status: r.status,
          is_active: r.is_active,
          created_at: r.created_at,
        })),
        byType: {
          labels: typesRes.rows.map((r) => r.label),
          series: typesRes.rows.map((r) => Number(r.count || 0)),
        },
        byStatus: {
          labels: statusRes.rows.map((r) => r.label),
          series: statusRes.rows.map((r) => Number(r.count || 0)),
        },
        // Elite-tier
        funnel: {
          views,
          saves,
          contacts,
          tours,
          save_rate: views > 0 ? ((saves / views) * 100).toFixed(1) : "0.0",
          contact_rate: views > 0 ? ((contacts / views) * 100).toFixed(1) : "0.0",
          tour_rate: views > 0 ? ((tours / views) * 100).toFixed(1) : "0.0",
          avg_views: Number(funnelRow.avg_views || 0).toFixed(1),
          avg_saves: Number(funnelRow.avg_saves || 0).toFixed(1),
          avg_contacts: Number(funnelRow.avg_contacts || 0).toFixed(1),
        },
        dayOfWeek: dowRes.rows.map((r) => ({
          day: r.day,
          listings: Number(r.listings || 0),
          views: Number(r.views || 0),
          contacts: Number(r.contacts || 0),
        })),
      },
    });
  } catch (err) {
    console.error("Owner Analytics Error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

export default router;