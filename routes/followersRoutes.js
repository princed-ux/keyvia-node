// keyvia-node/routes/followersRoutes.js
// ============================================================================
// FOLLOWERS SYSTEM ROUTES - Follow/Unfollow Agents & Users
// ============================================================================

import express from "express";
import {
  optionalAuth,
  authenticateToken,
} from "../middleware/authMiddleware.js";
import {
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
  isFollowing,
  getFollowerStats,
} from "../controllers/followersController.js";

const router = express.Router();

/**
 * ============================================================================
 * PUBLIC ROUTES (No auth required)
 * ============================================================================
 */

/**
 * GET /api/followers/:user_id/followers
 * Get list of followers for a user
 */
router.get("/:user_id/followers", getFollowers);

/**
 * GET /api/followers/:user_id/following
 * Get list of users this person follows
 */
router.get("/:user_id/following", getFollowing);

/**
 * GET /api/followers/:user_id/stats
 * Get follower statistics
 */
router.get("/:user_id/stats", getFollowerStats);

/**
 * GET /api/followers/:user_id/is-following
 * Check if authenticated user is following another user
 */
router.get("/:user_id/is-following", optionalAuth, isFollowing);

/**
 * ============================================================================
 * PROTECTED ROUTES (Authentication required)
 * ============================================================================
 */

/**
 * POST /api/followers/follow/:user_id
 * Follow a user
 */
router.post("/follow/:user_id", authenticateToken, followUser);

/**
 * DELETE /api/followers/unfollow/:user_id
 * Unfollow a user
 */
router.delete("/unfollow/:user_id", authenticateToken, unfollowUser);

export default router;
