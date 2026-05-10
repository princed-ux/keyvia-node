// keyvia-node/routes/ivsRoutes.js
// ============================================================================
// AWS IVS LIVE TOURS - Broadcasting & Viewing
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
} from "../controllers/ivsController.js";

const router = express.Router();

/**
 * POST /api/ivs/go-live
 * Host starts a live tour (creates IVS channel)
 */
router.post("/go-live", authenticateToken, goLive);

/**
 * POST /api/ivs/end-live/:tour_id
 * Host ends the live tour
 */
router.post("/end-live/:tour_id", authenticateToken, endLive);

/**
 * GET /api/ivs/my-active
 * Host restores active live rooms in studio
 */
router.get("/my-active", authenticateToken, getMyActiveTours);

/**
 * GET /api/ivs/live-now
 * Safe discovery list for buyers and other roles
 */
router.get("/live-now", optionalAuth, getLiveNowTours);

/**
 * GET /api/ivs/tour/:tour_id
 * Get tour details and check viewer access
 */
router.get("/tour/:tour_id", optionalAuth, getLiveTour);

/**
 * POST /api/ivs/tour/:tour_id/report
 * User/public safety report for suspicious live tours
 */
router.post("/tour/:tour_id/report", optionalAuth, reportLiveTour);

/**
 * POST /api/ivs/purchase-access/:tour_id
 * Disabled until live-tour payments pass compliance review
 */
router.post("/purchase-access/:tour_id", authenticateToken, purchaseAccess);

export default router;
