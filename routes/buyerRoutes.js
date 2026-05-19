import express from "express";
import { pool } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

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
// Recommendations based on saved favorites' locations, fallback to newest
router.get("/recommendations", authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.unique_id;
    if (!userId) return res.status(401).json({ error: "Authentication required" });

    const favCities = await pool.query(
      `SELECT DISTINCT l.city, l.state
       FROM favorites f
       JOIN listings l ON f.product_id = l.product_id
       WHERE f.user_id = $1
         AND l.city IS NOT NULL`,
      [userId],
    );

    let result;
    if (safeRows(favCities).length > 0) {
      const cities = favCities.rows.map((r) => r.city).filter(Boolean);
      const cityParams = cities.map((_, i) => `$${i + 1}`).join(", ");
      const query = `
        SELECT *
        FROM listings
        WHERE status = 'approved'
          AND city IN (${cityParams})
        ORDER BY created_at DESC
        LIMIT 12`;
      result = await pool.query(query, cities);
    }

    if (!result || safeRows(result).length === 0) {
      result = await pool.query(
        `SELECT *
         FROM listings
         WHERE status = 'approved'
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

export default router;
