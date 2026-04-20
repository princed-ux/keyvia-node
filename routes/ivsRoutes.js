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
  getLiveTour,
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
 * GET /api/ivs/tour/:tour_id
 * Get tour details and check viewer access
 */
router.get("/tour/:tour_id", optionalAuth, getLiveTour);

/**
 * POST /api/ivs/purchase-access/:tour_id
 * Viewer pays coins to watch tour
 */
router.post("/purchase-access/:tour_id", authenticateToken, purchaseAccess);

export default router;
