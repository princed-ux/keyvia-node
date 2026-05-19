import express from "express";
import { pool } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(authenticateToken);

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

router.get("/stats", async (req, res) => {
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

router.get("/charts/funding", async (req, res) => {
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

router.get("/charts/types", async (req, res) => {
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

router.get("/charts/status", async (req, res) => {
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

router.get("/transactions", async (req, res) => {
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

router.get("/analytics", async (req, res) => {
  const userKey = getUserKey(req);
  if (!userKey) return res.status(401).json({ error: "Unauthorized" });

  try {
    const [totalRes, monthlyRes, listingsRes, typesRes, statusRes] = await Promise.all([
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
    ]);

    const total = totalRes.rows[0] || {};
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
          views: total.views || 0,
          saves: total.saves || 0,
          contacts: total.contacts || 0,
          tour_requests: total.tour_requests || 0,
          shares: total.shares || 0,
        },
        monthly,
        byListing,
        byType,
        byStatus,
      },
    });
  } catch (err) {
    console.error("Agent Analytics Error:", err.message);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

export default router;
