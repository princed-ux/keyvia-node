import pkg from "pg";
const { Pool } = pkg;

import nlpSearchService from "../services/nlpSearchService.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

export const smartSearch = async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || !q.trim()) {
      return res.status(400).json({ error: "Query parameter 'q' is required" });
    }

    const parsed = nlpSearchService.parse(q);
    const queryParams = nlpSearchService.buildQueryParams(parsed);

    if (Object.keys(queryParams).length === 0) {
      const fallbackResult = await pool.query(
        `SELECT l.*,
          u.unique_id AS uploader_unique_id,
          u.name AS agent_name, u.avatar_url AS agent_avatar,
          (SELECT url FROM listing_photos WHERE listing_id = l.id AND is_primary = true LIMIT 1) AS photo_url
        FROM listings l
        JOIN users u ON l.uploaded_by_id = u.unique_id
        WHERE l.status = 'approved' AND l.is_active = true
          AND (
            l.city ILIKE $1 OR l.address ILIKE $1 OR l.state ILIKE $1
            OR l.neighborhood ILIKE $1 OR l.title ILIKE $1 OR l.description ILIKE $1
          )
        ORDER BY COALESCE(l.activated_at, l.created_at) DESC
        LIMIT 50`,
        [`%${q}%`]
      );
      return res.json({
        query: q,
        parsed,
        listings: fallbackResult.rows,
      });
    }

    const conditions = ["l.status = 'approved'", "l.is_active = true"];
    const params = [];
    let paramIndex = 1;

    if (queryParams.minBedrooms) {
      conditions.push(`COALESCE(l.bedrooms, 0) >= $${paramIndex++}`);
      params.push(parseInt(queryParams.minBedrooms, 10));
    }

    if (queryParams.minBathrooms) {
      conditions.push(`COALESCE(l.bathrooms, 0) >= $${paramIndex++}`);
      params.push(parseInt(queryParams.minBathrooms, 10));
    }

    if (queryParams.property_types) {
      const types = queryParams.property_types.split(",").map((t) => t.trim());
      const placeholders = types.map(() => `$${paramIndex++}`).join(", ");
      conditions.push(
        `regexp_replace(LOWER(l.property_type), '[\\s-]+', '_', 'g') IN (${placeholders})`
      );
      params.push(...types.map((t) => t.toLowerCase().replace(/[\s-]+/g, "_")));
    }

    if (queryParams.listing_types) {
      const types = queryParams.listing_types.split(",").map((t) => t.trim());
      const placeholders = types.map(() => `$${paramIndex++}`).join(", ");
      conditions.push(
        `regexp_replace(LOWER(l.listing_type), '[\\s-]+', '_', 'g') IN (${placeholders})`
      );
      params.push(...types.map((t) => t.toLowerCase().replace(/[\s-]+/g, "_")));
    }

    if (queryParams.city) {
      conditions.push(`(l.city ILIKE $${paramIndex} OR l.neighborhood ILIKE $${paramIndex} OR l.state ILIKE $${paramIndex})`);
      params.push(`%${queryParams.city}%`);
      paramIndex++;
    }

    if (queryParams.minPrice) {
      conditions.push(`l.price >= $${paramIndex++}`);
      params.push(parseFloat(queryParams.minPrice));
    }

    if (queryParams.maxPrice) {
      conditions.push(`l.price <= $${paramIndex++}`);
      params.push(parseFloat(queryParams.maxPrice));
    }

    if (queryParams.furnishing) {
      conditions.push(`regexp_replace(LOWER(l.furnishing), '[\\s-]+', '_', 'g') = $${paramIndex++}`);
      params.push(queryParams.furnishing.toLowerCase().replace(/[\s-]+/g, "_"));
    }

    if (queryParams.amenities) {
      const amenityList = queryParams.amenities.split(",").map((a) => a.trim());
      for (const amenity of amenityList) {
        const normalized = amenity.toLowerCase().replace(/[\s-]+/g, "_");
        conditions.push(
          `EXISTS (SELECT 1 FROM jsonb_array_elements_text(l.amenities::jsonb) AS amenity(value) WHERE LOWER(regexp_replace(amenity.value, '[\\s-]+', '_', 'g')) = $${paramIndex})`
        );
        params.push(normalized);
        paramIndex++;
      }
    }

    const whereClause = conditions.join(" AND ");

    const sql = `
      SELECT l.*,
        u.unique_id AS uploader_unique_id,
        u.name AS agent_name, u.avatar_url AS agent_avatar,
        (SELECT url FROM listing_photos WHERE listing_id = l.id AND is_primary = true LIMIT 1) AS photo_url
      FROM listings l
      JOIN users u ON l.uploaded_by_id = u.unique_id
      WHERE ${whereClause}
      ORDER BY COALESCE(l.activated_at, l.created_at) DESC
      LIMIT 50
    `;

    const result = await pool.query(sql, params);

    res.json({
      query: q,
      parsed,
      listings: result.rows,
    });
  } catch (err) {
    console.error("smartSearch error:", err);
    res.status(500).json({ error: "Smart search failed" });
  }
};
