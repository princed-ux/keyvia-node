import express from "express";
import { pool } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();

let favoritesSchemaReady = false;

const normalizeRole = (value) =>
  String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");

const canSaveHomes = (user) => {
  const role = normalizeRole(user?.role || user?.user_role || user?.account_type);
  return ["buyer", "customer", "renter", "tenant", "user"].includes(role);
};

const ensureFavoritesProductMode = async (client) => {
  if (favoritesSchemaReady) return;

  await client.query(`
    ALTER TABLE favorites
    ADD COLUMN IF NOT EXISTS product_id TEXT;
  `);

  await client.query(`
    ALTER TABLE favorites
    ALTER COLUMN listing_id DROP NOT NULL;
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_user_product_unique
      ON favorites(user_id, product_id)
      WHERE product_id IS NOT NULL;
  `);

  favoritesSchemaReady = true;
};

// ✅ 1. Toggle Favorite (Like/Unlike)
router.post("/toggle", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const { product_id } = req.body;
    const user_id = req.user.unique_id;

    if (!canSaveHomes(req.user)) {
      return res.status(403).json({
        success: false,
        message: "Only buyers and renters can save homes.",
        code: "SAVE_HOMES_BUYER_ONLY",
      });
    }

    if (!product_id) {
      return res.status(400).json({
        success: false,
        message: "Listing product ID is required.",
      });
    }

    await client.query("BEGIN");
    await ensureFavoritesProductMode(client);

    const listingResult = await client.query(
      `
      SELECT id, product_id
      FROM listings
      WHERE product_id = $1
      LIMIT 1
      `,
      [product_id],
    );

    const listing = listingResult.rows[0];

    if (!listing) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Listing not found.",
      });
    }

    // Check if it already exists
    const check = await client.query(
      `
      SELECT id
      FROM favorites
      WHERE user_id::text = $1::text
      AND (
        product_id = $2
        OR listing_id::text = $3::text
      )
      LIMIT 1
      `,
      [user_id, listing.product_id, listing.id],
    );

    if (check.rows.length > 0) {
      // It exists -> DELETE it (Unlike)
      await client.query("DELETE FROM favorites WHERE id = $1", [
        check.rows[0].id,
      ]);

      const countResult = await client.query(
        `
        UPDATE listings
        SET saves_count = GREATEST(COALESCE(saves_count, 0) - 1, 0)
        WHERE product_id = $1
        RETURNING saves_count
        `,
        [listing.product_id],
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        is_favorited: false,
        saves_count: countResult.rows[0]?.saves_count || 0,
        message: "Removed from saved homes",
      });
    } else {
      // It doesn't exist -> INSERT it (Like)
      const insertResult = await client.query(
        `
        INSERT INTO favorites (user_id, listing_id, product_id)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
        RETURNING id
        `,
        [user_id, listing.id || null, listing.product_id],
      );

      const countResult =
        insertResult.rowCount > 0
          ? await client.query(
              `
              UPDATE listings
              SET saves_count = COALESCE(saves_count, 0) + 1
              WHERE product_id = $1
              RETURNING saves_count
              `,
              [listing.product_id],
            )
          : await client.query(
              `
              SELECT COALESCE(saves_count, 0) AS saves_count
              FROM listings
              WHERE product_id = $1
              `,
              [listing.product_id],
            );

      // OPTIONAL: Notify the Agent here using Socket.IO or Email
      // const listing = await pool.query("SELECT agent_unique_id FROM listings WHERE product_id = $1", [product_id]);
      // sendNotification(listing.rows[0].agent_unique_id, "Someone liked your home!");

      await client.query("COMMIT");

      return res.json({
        success: true,
        is_favorited: true,
        saves_count: countResult.rows[0]?.saves_count || 0,
        message: "Added to saved homes",
      });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Could not update saved homes right now.",
    });
  } finally {
    client.release();
  }
});

// ✅ 2. Get User's Saved Homes (For "Saved Homes" Page)
router.get("/my-favorites", authenticateToken, async (req, res) => {
  try {
    const user_id = req.user.unique_id;

    // Join favorites with listings to get full property details
    const result = await pool.query(
      `
      SELECT l.*, true as is_favorited 
      FROM favorites f
      JOIN listings l ON f.product_id = l.product_id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
    `,
      [user_id],
    );

    // Parse JSON fields (photos/features)
    const favorites = result.rows.map((l) => ({
      ...l,
      photos: typeof l.photos === "string" ? JSON.parse(l.photos) : l.photos,
      features:
        typeof l.features === "string" ? JSON.parse(l.features) : l.features,
    }));

    res.json(favorites);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;

// ---------------------------
// Additional Endpoints
// ---------------------------
// 3. Get favorites for a specific user (own or admin only)
router.get("/user/:id", authenticateToken, async (req, res) => {
  try {
    const user_id = req.params.id;
    const isOwner = String(req.user.unique_id) === user_id;
    const isAdmin = req.user.is_admin || req.user.is_super_admin;
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const result = await pool.query(
      `
      SELECT l.*, true as is_favorited 
      FROM favorites f
      JOIN listings l ON f.product_id = l.product_id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
    `,
      [user_id],
    );

    const favorites = result.rows.map((l) => ({
      ...l,
      photos: typeof l.photos === "string" ? JSON.parse(l.photos) : l.photos,
      features:
        typeof l.features === "string" ? JSON.parse(l.features) : l.features,
    }));

    res.json(favorites);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// 4. Delete a favorite by id (route: DELETE /api/favorites/:id)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = req.params.id;

    // Ensure the favorite belongs to the requesting user
    const check = await pool.query("SELECT * FROM favorites WHERE id = $1", [
      id,
    ]);
    if (check.rows.length === 0)
      return res.status(404).json({ error: "Favorite not found" });

    const favorite = check.rows[0];
    if (favorite.user_id !== req.user.unique_id) {
      return res.status(403).json({ error: "Not authorized" });
    }

    await pool.query("DELETE FROM favorites WHERE id = $1", [id]);
    res.json({ message: "Removed from saved homes" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
