// keyvia-node/controllers/followersController.js
// ============================================================================
// FOLLOWERS SYSTEM - Follow/Unfollow Agents & Users
// ============================================================================

import { pool } from "../db.js";

/**
 * ============================================================================
 * 1. FOLLOW A USER (Agent, Owner, etc.)
 * ============================================================================
 * POST /api/followers/follow/:user_id
 */
export const followUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const followerId = req.user?.id;

    if (!followerId)
      return res.status(401).json({ error: "Not authenticated" });

    // Prevent self-follow
    if (followerId === user_id) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }

    // Check if already following
    const checkQuery = `
      SELECT id FROM followers WHERE follower_id = $1 AND following_id = $2
    `;
    const existing = await pool.query(checkQuery, [followerId, user_id]);

    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: "Already following this user",
      });
    }

    // Insert follow relationship
    const followQuery = `
      INSERT INTO followers (follower_id, following_id, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id, created_at
    `;
    const followResult = await pool.query(followQuery, [followerId, user_id]);

    // Update follower count denormalization
    await pool.query(
      `UPDATE users SET followers_count = followers_count + 1 
       WHERE unique_id = $1`,
      [user_id],
    );

    // Create notification
    await pool.query(
      `
      INSERT INTO notifications (recipient_id, title, message, type, resource_type, resource_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
      [
        user_id,
        "New Follower",
        `Someone started following you!`,
        "follow",
        "user",
        followerId,
      ],
    );

    console.log(`✅ User ${followerId} followed ${user_id}`);

    res.status(201).json({
      success: true,
      message: "User followed successfully",
      follow: followResult.rows[0],
    });
  } catch (error) {
    console.error("❌ Follow Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to follow user",
    });
  }
};

/**
 * ============================================================================
 * 2. UNFOLLOW A USER
 * ============================================================================
 * DELETE /api/followers/unfollow/:user_id
 */
export const unfollowUser = async (req, res) => {
  try {
    const { user_id } = req.params;
    const followerId = req.user?.id;

    if (!followerId)
      return res.status(401).json({ error: "Not authenticated" });

    // Delete follow relationship
    const deleteQuery = `
      DELETE FROM followers 
      WHERE follower_id = $1 AND following_id = $2
      RETURNING id
    `;
    const deleteResult = await pool.query(deleteQuery, [followerId, user_id]);

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({
        error: "Not following this user",
      });
    }

    // Update follower count
    await pool.query(
      `UPDATE users SET followers_count = MAX(0, followers_count - 1) 
       WHERE unique_id = $1`,
      [user_id],
    );

    console.log(`✅ User ${followerId} unfollowed ${user_id}`);

    res.json({
      success: true,
      message: "User unfollowed successfully",
    });
  } catch (error) {
    console.error("❌ Unfollow Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to unfollow user",
    });
  }
};

/**
 * ============================================================================
 * 3. GET FOLLOWERS LIST
 * ============================================================================
 * GET /api/followers/:user_id/followers
 */
export const getFollowers = async (req, res) => {
  try {
    const { user_id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    const query = `
      SELECT 
        u.unique_id, u.name, u.avatar_url, u.bio, u.role,
        u.verification_status, u.followers_count, u.listings_count,
        f.created_at
      FROM followers f
      JOIN users u ON f.follower_id = u.unique_id
      WHERE f.following_id = $1
      ORDER BY f.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM followers WHERE following_id = $1
    `;

    const [result, countResult] = await Promise.all([
      pool.query(query, [user_id, limit, offset]),
      pool.query(countQuery, [user_id]),
    ]);

    res.json({
      success: true,
      followers: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
    });
  } catch (error) {
    console.error("❌ Get Followers Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get followers",
    });
  }
};

/**
 * ============================================================================
 * 4. GET FOLLOWING LIST (Users this person follows)
 * ============================================================================
 * GET /api/followers/:user_id/following
 */
export const getFollowing = async (req, res) => {
  try {
    const { user_id } = req.params;
    const { limit = 20, offset = 0 } = req.query;

    const query = `
      SELECT 
        u.unique_id, u.name, u.avatar_url, u.bio, u.role,
        u.verification_status, u.followers_count, u.listings_count,
        f.created_at
      FROM followers f
      JOIN users u ON f.following_id = u.unique_id
      WHERE f.follower_id = $1
      ORDER BY f.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) as total FROM followers WHERE follower_id = $1
    `;

    const [result, countResult] = await Promise.all([
      pool.query(query, [user_id, limit, offset]),
      pool.query(countQuery, [user_id]),
    ]);

    res.json({
      success: true,
      following: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit,
      offset,
    });
  } catch (error) {
    console.error("❌ Get Following Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get following list",
    });
  }
};

/**
 * ============================================================================
 * 5. CHECK IF FOLLOWING
 * ============================================================================
 * GET /api/followers/:user_id/is-following
 */
export const isFollowing = async (req, res) => {
  try {
    const { user_id } = req.params;
    const authenticatedId = req.user?.id;

    if (!authenticatedId) {
      return res.json({ is_following: false });
    }

    const query = `
      SELECT id FROM followers 
      WHERE follower_id = $1 AND following_id = $2
    `;

    const result = await pool.query(query, [authenticatedId, user_id]);

    res.json({
      success: true,
      is_following: result.rows.length > 0,
      follower_id: authenticatedId,
      following_id: user_id,
    });
  } catch (error) {
    console.error("❌ Is Following Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to check following status",
    });
  }
};

/**
 * ============================================================================
 * 6. GET FOLLOWER STATISTICS
 * ============================================================================
 * GET /api/followers/:user_id/stats
 */
export const getFollowerStats = async (req, res) => {
  try {
    const { user_id } = req.params;

    const query = `
      SELECT 
        (SELECT COUNT(*) FROM followers WHERE following_id = $1) as followers_count,
        (SELECT COUNT(*) FROM followers WHERE follower_id = $1) as following_count,
        (SELECT listings_count FROM users WHERE unique_id = $1) as listings_count,
        (SELECT rating FROM users WHERE unique_id = $1) as rating
    `;

    const result = await pool.query(query, [user_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      success: true,
      stats: result.rows[0],
    });
  } catch (error) {
    console.error("❌ Stats Error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get follower stats",
    });
  }
};

export default {
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  isFollowing,
  getFollowerStats,
};
