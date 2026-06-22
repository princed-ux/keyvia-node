// keyvia-node/routes/ivsRoutes.js
// ============================================================================
// AWS IVS LIVE TOURS — Broadcasting, Viewing, Comments, Reactions, Follow
// ============================================================================

import express from "express";
import {
  authenticateToken,
  optionalAuth,
} from "../middleware/authMiddleware.js";
import {
  goLive,
  endLive,
  getLiveNowTours,
  getLiveTour,
  getMyActiveTours,
  reportLiveTour,
  purchaseAccess,
  getLiveTourComments,
  getReplays,
  getUpcomingTours,
  getRecentlyEndedTours,
  followHost,
  unfollowHost,
  getFollowStatus,
  getReactionSummary,
} from "../controllers/ivsController.js";

const router = express.Router();

// ── Host controls ──────────────────────────────────────────────────────────
router.post("/go-live",            authenticateToken, goLive);
router.post("/end-live/:tour_id",  authenticateToken, endLive);
router.get( "/my-active",          authenticateToken, getMyActiveTours);

// ── Discovery ──────────────────────────────────────────────────────────────
router.get("/live-now",        optionalAuth, getLiveNowTours);
router.get("/upcoming",        optionalAuth, getUpcomingTours);
router.get("/recently-ended",  optionalAuth, getRecentlyEndedTours);
router.get("/replays",         optionalAuth, getReplays);

// ── Single tour ────────────────────────────────────────────────────────────
router.get( "/tour/:tour_id",           optionalAuth, getLiveTour);
router.post("/tour/:tour_id/report",    optionalAuth, reportLiveTour);

// ── Comments ───────────────────────────────────────────────────────────────
router.get("/tour/:tour_id/comments", optionalAuth, getLiveTourComments);

// ── Reactions ──────────────────────────────────────────────────────────────
router.get("/tour/:tour_id/reactions", optionalAuth, getReactionSummary);

// ── Follow system ──────────────────────────────────────────────────────────
router.get(   "/follow/:host_id", authenticateToken, getFollowStatus);
router.post(  "/follow/:host_id", authenticateToken, followHost);
router.delete("/follow/:host_id", authenticateToken, unfollowHost);

// ── Disabled: live-tour payments ───────────────────────────────────────────
router.post("/purchase-access/:tour_id", authenticateToken, purchaseAccess);

export default router;
