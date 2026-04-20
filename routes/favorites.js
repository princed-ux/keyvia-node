import express from "express";
import { pool } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();

// ✅ 1. Toggle Favorite (Like/Unlike)
router.post("/toggle", authenticateToken, async (req, res) => {
  try {
    const { product_id } = req.body;
    const user_id = req.user.unique_id;

    // Check if it already exists
    const check = await pool.query(
      "SELECT * FROM favorites WHERE user_id = $1 AND product_id = $2",
      [user_id, product_id],
    );

    if (check.rows.length > 0) {
      // It exists -> DELETE it (Unlike)
      await pool.query(
        "DELETE FROM favorites WHERE user_id = $1 AND product_id = $2",
        [user_id, product_id],
      );
      return res.json({
        is_favorited: false,
        message: "Removed from saved homes",
      });
    } else {
      // It doesn't exist -> INSERT it (Like)
      await pool.query(
        "INSERT INTO favorites (user_id, product_id) VALUES ($1, $2)",
        [user_id, product_id],
      );

      // OPTIONAL: Notify the Agent here using Socket.IO or Email
      // const listing = await pool.query("SELECT agent_unique_id FROM listings WHERE product_id = $1", [product_id]);
      // sendNotification(listing.rows[0].agent_unique_id, "Someone liked your home!");

      return res.json({ is_favorited: true, message: "Added to saved homes" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
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
// 3. Get favorites for a specific user (admin or public use)
router.get("/user/:id", async (req, res) => {
  try {
    const user_id = req.params.id;
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
