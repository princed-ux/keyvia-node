import express from "express";
import { pool } from "../db.js";
import { authenticateToken, requireRole } from "../middleware/authMiddleware.js";
import { requireAnalytics } from "../middleware/planMiddleware.js";

const router = express.Router();

router.use(authenticateToken);
router.use(requireRole("agent", "brokerage_owner"));

const getUserKey = (req) => String(req.user?.unique_id || req.user?.id || "");

const listingOwnerWhere = `
  (
    l.uploaded_by_id::text = $1
    OR l.agent_unique_id::text = $1
    OR l.created_by::text = $1
    OR l.assigned_agent_id::text = $1
  )
`;

const tableExists = async (tableName) => {
  const result = await pool.query(
    `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = $1
    LIMIT 1
    `,
    [tableName],
  );

  return result.rowCount > 0;
};

const columnExists = async (tableName, columnName) => {
  const result = await pool.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [tableName, columnName],
  );

  return result.rowCount > 0;
};

const pickExistingColumn = async (tableName, candidates = []) => {
  for (const column of candidates) {
    if (await columnExists(tableName, column)) return column;
  }

  return null;
};

const normalizeStatus = (listing = {}) => {
  const status = String(listing.status || "").toLowerCase();

  if (status === "approved") return listing.is_active ? "Live" : "Approved";
  if (status === "live" || status === "active" || status === "published") return "Live";
  if (status === "pending") return "In review";
  if (status === "rejected") return "Needs fixes";
  if (status === "draft") return "Draft";

  return listing.status || "Unknown";
};

const getPrimaryImage = (listing = {}) => {
  const parse = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return [value];

    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  };

  const media = [
    ...parse(listing.photos),
    ...parse(listing.images_urls),
    ...parse(listing.image_urls),
  ];

  const first = media.find(Boolean);
  if (typeof first === "string") return first;
  return first?.url || first?.secure_url || first?.location || "/placeholder-property.jpg";
};

const getPaymentWhere = async (userKey) => {
  if (!(await tableExists("payments"))) return null;
  if (!(await columnExists("payments", "user_id"))) return null;
  if (!(await columnExists("payments", "amount"))) return null;

  const statusColumn = await pickExistingColumn("payments", ["status", "payment_status"]);

  return {
    userKey,
    statusColumn,
    statusClause: statusColumn
      ? `AND LOWER(COALESCE(${statusColumn}::text, '')) IN ('successful', 'success', 'paid', 'completed')`
      : "",
  };
};

router.get("/stats", requireAnalytics("basic"), async (req, res) => {
  const userKey = getUserKey(req);

  if (!userKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const [listRes, paymentMeta] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS listings,
          COUNT(*) FILTER (
            WHERE COALESCE(l.is_active, false) = true
              AND LOWER(COALESCE(l.status::text, '')) IN ('approved', 'live', 'published', 'active')
          )::int AS active,
          COALESCE(SUM(COALESCE(l.views_count, 0)), 0)::int AS views,
          COALESCE(SUM(COALESCE(l.saves_count, 0)), 0)::int AS saves,
          COALESCE(SUM(COALESCE(l.contact_count, 0)), 0)::int AS contacts
        FROM listings l
        WHERE ${listingOwnerWhere}
        `,
        [userKey],
      ),
      getPaymentWhere(userKey),
    ]);

    let totalSpent = 0;

    if (paymentMeta) {
      const spentRes = await pool.query(
        `
        SELECT COALESCE(SUM(amount), 0)::float AS total
        FROM payments
        WHERE user_id::text = $1
          ${paymentMeta.statusClause}
        `,
        [userKey],
      );
      totalSpent = Number(spentRes.rows[0]?.total || 0);
    }

    const row = listRes.rows[0] || {};

    return res.json({
      listings: row.listings || 0,
      active: row.active || 0,
      views: row.views || 0,
      saves: row.saves || 0,
      contacts: row.contacts || 0,
      total_spent: totalSpent,
    });
  } catch (err) {
    console.error("Stats Error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/charts/funding", requireAnalytics("basic"), async (req, res) => {
  const userKey = getUserKey(req);

  try {
    const paymentMeta = await getPaymentWhere(userKey);

    if (!paymentMeta || !(await columnExists("payments", "created_at"))) {
      return res.json({ data: Array(7).fill(0) });
    }

    const purposeColumn = await pickExistingColumn("payments", [
      "purpose",
      "transaction_type",
      "payment_type",
      "type",
    ]);
    const purposeClause = purposeColumn
      ? `AND LOWER(COALESCE(${purposeColumn}::text, '')) IN ('wallet_funding', 'wallet funding', 'subscription', 'listing_activation', 'listing activation')`
      : "";

    const result = await pool.query(
      `
      SELECT EXTRACT(ISODOW FROM created_at)::int AS day_num,
             SUM(amount)::float AS total
      FROM payments
      WHERE user_id::text = $1
        ${paymentMeta.statusClause}
        ${purposeClause}
        AND created_at >= DATE_TRUNC('week', CURRENT_DATE)
      GROUP BY day_num
      ORDER BY day_num ASC
      `,
      [userKey],
    );

    const weeklyData = Array(7).fill(0);
    result.rows.forEach((row) => {
      if (row.day_num >= 1 && row.day_num <= 7) {
        weeklyData[row.day_num - 1] = Number(row.total || 0);
      }
    });

    return res.json({ data: weeklyData });
  } catch (err) {
    console.error("Funding Chart Error:", err.message);
    return res.json({ data: Array(7).fill(0) });
  }
});

router.get("/charts/types", requireAnalytics("basic"), async (req, res) => {
  const userKey = getUserKey(req);

  try {
    const result = await pool.query(
      `
      SELECT COALESCE(NULLIF(l.property_type::text, ''), 'Other') AS property_type,
             COUNT(*)::int AS count
      FROM listings l
      WHERE ${listingOwnerWhere}
      GROUP BY property_type
      ORDER BY count DESC
      `,
      [userKey],
    );

    return res.json({
      labels: result.rows.map((row) => row.property_type),
      series: result.rows.map((row) => Number(row.count || 0)),
    });
  } catch (err) {
    console.error("Type Chart Error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/charts/status", requireAnalytics("basic"), async (req, res) => {
  const userKey = getUserKey(req);

  try {
    const result = await pool.query(
      `
      SELECT
        CASE
          WHEN COALESCE(l.is_active, false) = true
            AND LOWER(COALESCE(l.status::text, '')) IN ('approved', 'live', 'published', 'active')
            THEN 'Live'
          WHEN LOWER(COALESCE(l.status::text, '')) = 'approved' THEN 'Approved'
          WHEN LOWER(COALESCE(l.status::text, '')) = 'pending' THEN 'In review'
          WHEN LOWER(COALESCE(l.status::text, '')) = 'rejected' THEN 'Needs fixes'
          WHEN LOWER(COALESCE(l.status::text, '')) = 'draft' THEN 'Draft'
          ELSE 'Unknown'
        END AS status_label,
        COUNT(*)::int AS count
      FROM listings l
      WHERE ${listingOwnerWhere}
      GROUP BY status_label
      ORDER BY count DESC
      `,
      [userKey],
    );

    return res.json({
      labels: result.rows.map((row) => row.status_label),
      series: result.rows.map((row) => Number(row.count || 0)),
    });
  } catch (err) {
    console.error("Status Chart Error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/listings", async (req, res) => {
  const userKey = getUserKey(req);
  const limit = Math.min(Number(req.query.limit || 5), 25);

  try {
    const result = await pool.query(
      `
      SELECT l.*
      FROM listings l
      WHERE ${listingOwnerWhere}
      ORDER BY COALESCE(l.created_at, l.updated_at) DESC NULLS LAST
      LIMIT $2
      `,
      [userKey, limit],
    );

    return res.json(
      result.rows.map((row) => ({
        id: row.product_id || row.id,
        product_id: row.product_id,
        title: row.title,
        location: [row.city, row.state, row.country].filter(Boolean).join(", ") || "Unknown",
        price: Number(row.price || 0),
        status: normalizeStatus(row),
        views: Number(row.views_count || 0),
        saves: Number(row.saves_count || 0),
        contacts: Number(row.contact_count || 0),
        updated_at: row.last_updated_at || row.updated_at,
        image: getPrimaryImage(row),
      })),
    );
  } catch (err) {
    console.error("Listings Error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/transactions", requireAnalytics("basic"), async (req, res) => {
  const userKey = getUserKey(req);
  const limit = Math.min(Number(req.query.limit || 5), 25);

  try {
    const paymentMeta = await getPaymentWhere(userKey);

    if (!paymentMeta) {
      return res.json([]);
    }

    const labelColumn = await pickExistingColumn("payments", [
      "purpose",
      "transaction_type",
      "payment_type",
      "type",
      "description",
    ]);
    const createdColumn = (await columnExists("payments", "created_at"))
      ? "created_at"
      : "NOW()";

    const result = await pool.query(
      `
      SELECT
        id,
        amount,
        ${labelColumn ? `${labelColumn}::text` : "'Payment'"} AS type,
        ${paymentMeta.statusColumn ? `${paymentMeta.statusColumn}::text` : "'completed'"} AS status,
        ${createdColumn} AS date
      FROM payments
      WHERE user_id::text = $1
      ORDER BY date DESC
      LIMIT $2
      `,
      [userKey, limit],
    );

    return res.json(
      result.rows.map((row) => ({
        id: row.id,
        amount: Number(row.amount || 0),
        type: row.type || "Payment",
        status: row.status || "completed",
        date: row.date,
      })),
    );
  } catch (err) {
    console.error("Txn Error:", err.message);
    return res.json([]);
  }
});

router.get("/analytics", requireAnalytics("advanced"), async (req, res) => {
  const userKey = getUserKey(req);
  if (!userKey) return res.status(401).json({ error: "Unauthorized" });

  try {
    const [totalRes, monthlyRes, listingsRes, typesRes, statusRes, funnelRes, dowRes, priceBandRes] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*)::int AS listings,
          COUNT(*) FILTER (WHERE COALESCE(is_active, false) = true AND LOWER(COALESCE(status::text, '')) IN ('approved','live','published','active'))::int AS active,
          COALESCE(SUM(COALESCE(views_count, 0)), 0)::int AS views,
          COALESCE(SUM(COALESCE(saves_count, 0)), 0)::int AS saves,
          COALESCE(SUM(COALESCE(contact_count, 0)), 0)::int AS contacts,
          COALESCE(SUM(COALESCE(tour_request_count, 0)), 0)::int AS tour_requests,
          COALESCE(SUM(COALESCE(shares_count, 0)), 0)::int AS shares
        FROM listings l WHERE ${listingOwnerWhere}`,
        [userKey],
      ),
      pool.query(
        `SELECT
          TO_CHAR(DATE_TRUNC('month', l.created_at), 'YYYY-MM') AS month,
          COUNT(*)::int AS listings_added,
          COALESCE(SUM(COALESCE(l.views_count, 0)), 0)::int AS views,
          COALESCE(SUM(COALESCE(l.saves_count, 0)), 0)::int AS saves,
          COALESCE(SUM(COALESCE(l.contact_count, 0)), 0)::int AS contacts
        FROM listings l
        WHERE ${listingOwnerWhere}
          AND l.created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
        GROUP BY DATE_TRUNC('month', l.created_at)
        ORDER BY month ASC`,
        [userKey],
      ),
      pool.query(
        `SELECT
          l.product_id,
          l.title,
          COALESCE(l.views_count, 0)::int AS views,
          COALESCE(l.saves_count, 0)::int AS saves,
          COALESCE(l.contact_count, 0)::int AS contacts,
          COALESCE(l.tour_request_count, 0)::int AS tour_requests
        FROM listings l
        WHERE ${listingOwnerWhere}
        ORDER BY COALESCE(l.views_count, 0) DESC
        LIMIT 20`,
        [userKey],
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(l.property_type::text, ''), 'Other') AS label, COUNT(*)::int AS count
        FROM listings l WHERE ${listingOwnerWhere}
        GROUP BY label ORDER BY count DESC`,
        [userKey],
      ),
      pool.query(
        `SELECT
          CASE
            WHEN COALESCE(l.is_active, false) = true AND LOWER(COALESCE(l.status::text, '')) IN ('approved','live','published','active') THEN 'Live'
            WHEN LOWER(COALESCE(l.status::text, '')) = 'approved' THEN 'Approved'
            WHEN LOWER(COALESCE(l.status::text, '')) = 'pending' THEN 'In review'
            WHEN LOWER(COALESCE(l.status::text, '')) = 'rejected' THEN 'Needs fixes'
            WHEN LOWER(COALESCE(l.status::text, '')) = 'draft' THEN 'Draft'
            ELSE 'Unknown'
          END AS label,
          COUNT(*)::int AS count
        FROM listings l WHERE ${listingOwnerWhere}
        GROUP BY label ORDER BY count DESC`,
        [userKey],
      ),
      // Engagement funnel conversion rates (Elite)
      pool.query(
        `SELECT
          COALESCE(SUM(COALESCE(views_count,0)),0)::int AS total_views,
          COALESCE(SUM(COALESCE(saves_count,0)),0)::int AS total_saves,
          COALESCE(SUM(COALESCE(contact_count,0)),0)::int AS total_contacts,
          COALESCE(SUM(COALESCE(tour_request_count,0)),0)::int AS total_tours,
          AVG(COALESCE(views_count,0))::float AS avg_views,
          AVG(COALESCE(saves_count,0))::float AS avg_saves,
          AVG(COALESCE(contact_count,0))::float AS avg_contacts
        FROM listings l WHERE ${listingOwnerWhere}`,
        [userKey],
      ),
      // Day-of-week engagement (Elite)
      pool.query(
        `SELECT
          TO_CHAR(l.created_at, 'Dy') AS day,
          EXTRACT(DOW FROM l.created_at)::int AS day_num,
          COUNT(*)::int AS listings,
          COALESCE(SUM(COALESCE(l.views_count,0)),0)::int AS views,
          COALESCE(SUM(COALESCE(l.contact_count,0)),0)::int AS contacts
        FROM listings l
        WHERE ${listingOwnerWhere}
        GROUP BY day, day_num
        ORDER BY day_num`,
        [userKey],
      ),
      // Price band performance (Elite) — group listings by price range
      pool.query(
        `SELECT
          CASE
            WHEN l.price < 1000000 THEN 'Under ₦1M'
            WHEN l.price < 5000000 THEN '₦1M–5M'
            WHEN l.price < 20000000 THEN '₦5M–20M'
            WHEN l.price < 50000000 THEN '₦20M–50M'
            ELSE 'Over ₦50M'
          END AS price_band,
          COUNT(*)::int AS count,
          COALESCE(AVG(COALESCE(views_count,0)),0)::float AS avg_views,
          COALESCE(AVG(COALESCE(contact_count,0)),0)::float AS avg_contacts,
          COALESCE(AVG(COALESCE(saves_count,0)),0)::float AS avg_saves
        FROM listings l
        WHERE ${listingOwnerWhere}
          AND l.price IS NOT NULL AND l.price > 0
        GROUP BY price_band
        ORDER BY MIN(l.price)`,
        [userKey],
      ),
    ]);

    const total = totalRes.rows[0] || {};
    const funnelRow = funnelRes.rows[0] || {};
    const views = Number(total.views || 0);
    const saves = Number(total.saves || 0);
    const contacts = Number(total.contacts || 0);
    const tours = Number(total.tour_requests || 0);

    const monthly = monthlyRes.rows.map((r) => ({
      month: r.month,
      listings_added: Number(r.listings_added || 0),
      views: Number(r.views || 0),
      saves: Number(r.saves || 0),
      contacts: Number(r.contacts || 0),
    }));
    const byListing = listingsRes.rows.map((r) => ({
      product_id: r.product_id,
      title: r.title || "Untitled",
      views: Number(r.views || 0),
      saves: Number(r.saves || 0),
      contacts: Number(r.contacts || 0),
      tour_requests: Number(r.tour_requests || 0),
    }));
    const byType = { labels: typesRes.rows.map((r) => r.label), series: typesRes.rows.map((r) => Number(r.count || 0)) };
    const byStatus = { labels: statusRes.rows.map((r) => r.label), series: statusRes.rows.map((r) => Number(r.count || 0)) };

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
        monthly,
        byListing,
        byType,
        byStatus,
        // Elite-tier: engagement funnel conversion rates
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
        // Elite-tier: day-of-week performance
        dayOfWeek: dowRes.rows.map((r) => ({
          day: r.day,
          listings: Number(r.listings || 0),
          views: Number(r.views || 0),
          contacts: Number(r.contacts || 0),
        })),
        // Elite-tier: price band performance
        priceBands: priceBandRes.rows.map((r) => ({
          band: r.price_band,
          count: Number(r.count || 0),
          avg_views: Number(r.avg_views || 0).toFixed(1),
          avg_contacts: Number(r.avg_contacts || 0).toFixed(1),
          avg_saves: Number(r.avg_saves || 0).toFixed(1),
        })),
      },
    });
  } catch (err) {
    console.error("Agent Analytics Error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ─── COMMISSION TRACKING ───────────────────────────────────────────────────

const ensureCommissionsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_commissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id TEXT NOT NULL,
      listing_id TEXT,
      product_id TEXT,
      client_name TEXT,
      transaction_type VARCHAR(30) DEFAULT 'sale',
      gross_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
      commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
      commission_amount NUMERIC(15,2) GENERATED ALWAYS AS (ROUND(gross_amount * commission_rate / 100, 2)) STORED,
      currency VARCHAR(10) DEFAULT 'NGN',
      status VARCHAR(20) DEFAULT 'pending',
      notes TEXT,
      transaction_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_commissions_agent ON agent_commissions(agent_id);
  `);
};

// GET /agents/commissions
router.get("/commissions", async (req, res) => {
  const agentId = getUserKey(req);
  if (!agentId) return res.status(401).json({ error: "Unauthorized" });

  try {
    await ensureCommissionsTable();
    const result = await pool.query(
      `SELECT ac.*,
              l.title AS listing_title,
              l.address AS listing_address
       FROM agent_commissions ac
       LEFT JOIN listings l ON l.product_id::text = ac.product_id::text
       WHERE ac.agent_id = $1
       ORDER BY ac.transaction_date DESC, ac.created_at DESC`,
      [agentId],
    );
    return res.json(result.rows);
  } catch (err) {
    console.error("Commissions GET error:", err.message);
    return res.status(500).json({ error: "Could not fetch commissions" });
  }
});

// POST /agents/commissions — log a new commission entry
router.post("/commissions", async (req, res) => {
  const agentId = getUserKey(req);
  if (!agentId) return res.status(401).json({ error: "Unauthorized" });

  const {
    listing_id, product_id, client_name, transaction_type,
    gross_amount, commission_rate, currency, notes, transaction_date,
  } = req.body;

  if (!gross_amount || commission_rate === undefined) {
    return res.status(400).json({ error: "gross_amount and commission_rate are required." });
  }

  try {
    await ensureCommissionsTable();
    const result = await pool.query(
      `INSERT INTO agent_commissions
         (agent_id, listing_id, product_id, client_name, transaction_type,
          gross_amount, commission_rate, currency, notes, transaction_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        agentId, listing_id || null, product_id || null, client_name || null,
        transaction_type || "sale", gross_amount, commission_rate,
        currency || "NGN", notes || null, transaction_date || new Date(),
      ],
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Commissions POST error:", err.message);
    return res.status(500).json({ error: "Could not save commission" });
  }
});

// PATCH /agents/commissions/:id — update status or notes
router.patch("/commissions/:id", async (req, res) => {
  const agentId = getUserKey(req);
  if (!agentId) return res.status(401).json({ error: "Unauthorized" });

  const { status, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE agent_commissions
       SET status = COALESCE($1, status),
           notes = COALESCE($2, notes),
           updated_at = NOW()
       WHERE id = $3 AND agent_id = $4
       RETURNING *`,
      [status || null, notes || null, req.params.id, agentId],
    );
    if (!result.rows.length) return res.status(404).json({ error: "Commission not found." });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("Commissions PATCH error:", err.message);
    return res.status(500).json({ error: "Could not update commission" });
  }
});

// DELETE /agents/commissions/:id
router.delete("/commissions/:id", async (req, res) => {
  const agentId = getUserKey(req);
  if (!agentId) return res.status(401).json({ error: "Unauthorized" });

  try {
    await pool.query(
      "DELETE FROM agent_commissions WHERE id = $1 AND agent_id = $2",
      [req.params.id, agentId],
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("Commissions DELETE error:", err.message);
    return res.status(500).json({ error: "Could not delete commission" });
  }
});

export default router;
