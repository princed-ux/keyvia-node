import express from "express";
import { pool } from "../db.js";
import { authenticateToken, requireRole } from "../middleware/authMiddleware.js";

const router = express.Router();

const parsePhotos = (rows) =>
  rows.map((r) => ({
    ...r,
    photos:
      typeof r.photos === "string" ? JSON.parse(r.photos) : r.photos || [],
    features:
      typeof r.features === "string" ? JSON.parse(r.features) : r.features,
  }));

const enrichWithLiveTour = async (listings) => {
  if (!listings.length) return listings;
  const ids = listings.map((l) => l.id).filter(Boolean);
  if (!ids.length) return listings;
  try {
    const result = await pool.query(
      `SELECT lt.property_id, lt.id AS live_tour_id, lt.is_live,
              lt.current_viewers, lt.total_viewers, lt.peak_viewers
       FROM live_tours lt
       WHERE lt.property_id = ANY($1::uuid[])
         AND lt.is_live = TRUE`,
      [ids],
    );
    const tourMap = new Map(result.rows.map((r) => [r.property_id, r]));
    return listings.map((l) => ({
      ...l,
      live_now: tourMap.has(l.id),
      live_tour_status: tourMap.has(l.id) ? "live" : null,
      live_tour_id: tourMap.get(l.id)?.live_tour_id || null,
      current_viewers: Number(tourMap.get(l.id)?.current_viewers || 0),
      total_viewers: Number(tourMap.get(l.id)?.total_viewers || 0),
      peak_viewers: Number(tourMap.get(l.id)?.peak_viewers || 0),
    }));
  } catch {
    return listings;
  }
};

function safeRows(result) {
  return result?.rows || [];
}

// GET /api/buyer/recommendations
// Personalized recommendations based on: favorites city/type/price range → property type → fallback to newest
router.get("/recommendations", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    // 1. Derive signals from user's favorites
    const sigRes = await pool.query(
      `SELECT
         l.city,
         l.state,
         l.listing_type,
         l.property_type,
         l.price,
         l.currency
       FROM favorites f
       JOIN listings l ON l.product_id = f.product_id
       WHERE f.user_id = $1
         AND l.status IN ('approved', 'active')
       ORDER BY f.created_at DESC
       LIMIT 20`,
      [userId],
    );

    const signals = safeRows(sigRes);

    let result;

    if (signals.length > 0) {
      // Build preference profile from favorites
      const cities = [...new Set(signals.map((r) => r.city).filter(Boolean))].slice(0, 5);
      const propertyTypes = [...new Set(signals.map((r) => r.property_type).filter(Boolean))].slice(0, 4);
      const listingTypes = [...new Set(signals.map((r) => r.listing_type).filter(Boolean))].slice(0, 3);
      const prices = signals.map((r) => Number(r.price)).filter((p) => p > 0);
      const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
      const preferredCurrency = signals.find((r) => r.currency)?.currency || null;

      // Build a scored query:
      // +3 pts if city matches, +2 if property_type matches, +2 if listing_type matches, +1 if price within 40% of avg
      const cityPlaceholders = cities.map((_, i) => `$${i + 2}`);
      const allParams = [userId, ...cities];

      let scoreExpr = `(
        CASE WHEN city = ANY(ARRAY[${cityPlaceholders.join(",")}]) THEN 3 ELSE 0 END
      )`;

      if (propertyTypes.length) {
        const ptIdx = allParams.length + 1;
        allParams.push(propertyTypes);
        scoreExpr += ` + CASE WHEN property_type = ANY($${ptIdx}::text[]) THEN 2 ELSE 0 END`;
      }

      if (listingTypes.length) {
        const ltIdx = allParams.length + 1;
        allParams.push(listingTypes);
        scoreExpr += ` + CASE WHEN listing_type = ANY($${ltIdx}::text[]) THEN 2 ELSE 0 END`;
      }

      if (avgPrice) {
        const priceIdx = allParams.length + 1;
        allParams.push(avgPrice);
        scoreExpr += ` + CASE WHEN price BETWEEN $${priceIdx} * 0.6 AND $${priceIdx} * 1.4 THEN 1 ELSE 0 END`;
      }

      result = await pool.query(
        `SELECT *, (${scoreExpr}) AS relevance_score
         FROM listings
         WHERE status IN ('approved', 'active')
           AND product_id NOT IN (
             SELECT product_id FROM favorites WHERE user_id = $1
           )
         ORDER BY relevance_score DESC, created_at DESC
         LIMIT 12`,
        allParams,
      );

      // Fallback if scored query returns nothing
      if (!safeRows(result).length && cities.length) {
        const cityParams = cities.map((_, i) => `$${i + 1}`).join(", ");
        result = await pool.query(
          `SELECT * FROM listings
           WHERE status IN ('approved', 'active')
             AND city IN (${cityParams})
           ORDER BY created_at DESC LIMIT 12`,
          cities,
        );
      }
    }

    // Final fallback: newest approved listings
    if (!result || !safeRows(result).length) {
      result = await pool.query(
        `SELECT * FROM listings
         WHERE status IN ('approved', 'active')
         ORDER BY created_at DESC
         LIMIT 12`,
      );
    }

    const enriched = await enrichWithLiveTour(parsePhotos(safeRows(result)));
    return res.json(enriched);
  } catch (err) {
    console.error("Recommendations error:", err);
    return res.status(500).json({ error: "Could not fetch recommendations" });
  }
});

// GET /api/buyer/alerts
// Buyer-relevant notifications about saved properties
router.get("/alerts", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const result = await pool.query(
      `SELECT id, title, message, type, resource_type, resource_id,
               is_read, created_at
       FROM notifications
       WHERE recipient_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [userId],
    );

    return res.json(safeRows(result));
  } catch (err) {
    console.error("Alerts error:", err);
    return res.status(500).json({ error: "Could not fetch alerts" });
  }
});

// GET /api/buyer/viewings
// Tour requests submitted by this buyer
router.get("/viewings", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const result = await pool.query(
      `SELECT
         li.inquiry_id AS id,
         li.product_id,
         li.inquiry_status AS status,
         li.crm_status,
         li.metadata,
         li.last_contacted_at,
         li.created_at,
         l.title AS listing_title,
         l.address AS listing_address,
         l.city AS listing_city,
         l.state AS listing_state,
         l.price AS listing_price,
         l.currency AS listing_currency,
         l.photos AS listing_photos,
         COALESCE(u.name, u.full_name) AS agent_name,
         u.avatar_url AS agent_avatar
       FROM listing_inquiries li
       LEFT JOIN listings l ON l.product_id = li.product_id
       LEFT JOIN users u ON u.unique_id::text = li.agent_id::text
       WHERE li.buyer_id::text = $1
         AND li.metadata->>'inquiry_type' = 'tour_request'
       ORDER BY li.created_at DESC
       LIMIT 50`,
      [userId]
    );

    const rows = safeRows(result).map((r) => ({
      ...r,
      metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata || {},
      listing_photos: (() => {
        try {
          const p = typeof r.listing_photos === "string" ? JSON.parse(r.listing_photos) : r.listing_photos;
          return Array.isArray(p) ? p : [];
        } catch { return []; }
      })(),
    }));

    return res.json(rows);
  } catch (err) {
    console.error("Viewings error:", err);
    return res.status(500).json({ error: "Could not fetch viewings" });
  }
});

// GET /api/buyer/tours/upcoming
// Upcoming (scheduled but not yet live) property tours
router.get("/tours/upcoming", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lt.*,
              l.title AS property_title,
              l.product_id,
              l.photos,
              l.address,
              l.city,
              l.state,
              l.country,
                COALESCE(u.name, 'A Keyvia host') AS host_name
       FROM live_tours lt
       JOIN listings l ON lt.property_id = l.id
       LEFT JOIN users u ON lt.host_id = u.unique_id
       WHERE lt.is_live = FALSE
         AND lt.ended_at IS NULL
       ORDER BY lt.created_at DESC
       LIMIT 20`,
    );

    const rows = safeRows(result).map((r) => ({
      ...r,
      photos: typeof r.photos === "string" ? JSON.parse(r.photos) : r.photos,
    }));

    return res.json(rows);
  } catch (err) {
    console.error("Upcoming tours error:", err);
    return res.status(500).json({ error: "Could not fetch upcoming tours" });
  }
});

// =====================================================
// SAVED SEARCHES
// Buyers save a set of /buy filters and can opt into alerts when new approved
// listings match (delivery handled by services/savedSearchService.js).
// =====================================================
let savedSearchesTableReady = false;
const ensureSavedSearchesTable = async () => {
  if (savedSearchesTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      name TEXT NOT NULL,
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      page_type TEXT NOT NULL DEFAULT 'buy',
      alerts_enabled BOOLEAN NOT NULL DEFAULT true,
      last_alerted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id)`,
  );
  savedSearchesTableReady = true;
};

// GET /api/buyer/saved-searches
router.get("/saved-searches", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    await ensureSavedSearchesTable();
    const result = await pool.query(
      `SELECT id, name, filters, page_type, alerts_enabled, created_at, last_alerted_at
       FROM saved_searches WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return res.json(safeRows(result));
  } catch (err) {
    console.error("Saved searches list error:", err);
    return res.status(500).json({ error: "Could not load saved searches" });
  }
});

// POST /api/buyer/saved-searches  { name, filters, page_type, alerts_enabled }
router.post("/saved-searches", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    await ensureSavedSearchesTable();

    const name =
      String(req.body?.name || "").trim().slice(0, 120) || "Saved search";
    const filters =
      req.body?.filters && typeof req.body.filters === "object"
        ? req.body.filters
        : {};
    const pageType =
      String(req.body?.page_type || "buy").trim().slice(0, 20) || "buy";
    const alertsEnabled = req.body?.alerts_enabled !== false;

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM saved_searches WHERE user_id = $1`,
      [userId],
    );
    if ((countRes.rows[0]?.n || 0) >= 50) {
      return res
        .status(400)
        .json({ error: "You've reached the maximum of 50 saved searches." });
    }

    const result = await pool.query(
      `INSERT INTO saved_searches (user_id, name, filters, page_type, alerts_enabled)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id, name, filters, page_type, alerts_enabled, created_at, last_alerted_at`,
      [userId, name, JSON.stringify(filters), pageType, alertsEnabled],
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Saved search create error:", err);
    return res.status(500).json({ error: "Could not save search" });
  }
});

// PATCH /api/buyer/saved-searches/:id  { alerts_enabled?, name? }
router.patch("/saved-searches/:id", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    await ensureSavedSearchesTable();

    const fields = [];
    const values = [];
    let i = 1;
    if (typeof req.body?.alerts_enabled === "boolean") {
      fields.push(`alerts_enabled = $${i++}`);
      values.push(req.body.alerts_enabled);
    }
    if (typeof req.body?.name === "string") {
      fields.push(`name = $${i++}`);
      values.push(req.body.name.trim().slice(0, 120) || "Saved search");
    }
    if (!fields.length)
      return res.status(400).json({ error: "Nothing to update" });

    values.push(req.params.id, userId);
    const result = await pool.query(
      `UPDATE saved_searches SET ${fields.join(", ")}
       WHERE id = $${i++} AND user_id = $${i}
       RETURNING id, name, filters, page_type, alerts_enabled, created_at, last_alerted_at`,
      values,
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Saved search not found" });
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("Saved search update error:", err);
    return res.status(500).json({ error: "Could not update saved search" });
  }
});

// DELETE /api/buyer/saved-searches/:id
router.delete("/saved-searches/:id", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    await ensureSavedSearchesTable();
    const result = await pool.query(
      `DELETE FROM saved_searches WHERE id = $1 AND user_id = $2 RETURNING id`,
      [req.params.id, userId],
    );
    if (!result.rows.length)
      return res.status(404).json({ error: "Saved search not found" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Saved search delete error:", err);
    return res.status(500).json({ error: "Could not delete saved search" });
  }
});

export default router;
