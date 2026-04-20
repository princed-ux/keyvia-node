// keyvia-node/routes/brokerageManagement.js
// ============================================================================
// BROKERAGE MANAGEMENT ROUTES - Full Team Code & Brokerage Operations
// ============================================================================

import express from "express";
import {
  authenticateToken,
  verifyAdmin,
} from "../middleware/authMiddleware.js";
import {
  createBrokerage,
  generateNewTeamCode,
  verifyTeamCode,
  getBrokerage,
  getBrokerageAgents,
  updateBrokerage,
} from "../controllers/brokerageController.js";

const router = express.Router();

/**
 * ============================================================================
 * PUBLIC ROUTES
 * ============================================================================
 */

/**
 * POST /api/brokerage/verify-team-code
 * Verify team code (used during agent signup)
 * No authentication required
 */
router.post("/verify-team-code", verifyTeamCode);

/**
 * GET /api/brokerage/:brokerage_id
 * Get public brokerage info
 */
router.get("/:brokerage_id", getBrokerage);

/**
 * GET /api/brokerage/:brokerage_id/agents
 * Get all agents in a brokerage
 */
router.get("/:brokerage_id/agents", getBrokerageAgents);

/**
 * ============================================================================
 * PROTECTED ROUTES (Authenticated Users)
 * ============================================================================
 */

/**
 * POST /api/brokerage/create
 * Create new brokerage (brokerage owner signup)
 */
router.post("/create", authenticateToken, createBrokerage);

/**
 * PUT /api/brokerage/:brokerage_id
 * Update brokerage info (owner only)
 */
router.put("/:brokerage_id", authenticateToken, updateBrokerage);

/**
 * POST /api/brokerage/:brokerage_id/generate-team-code
 * Generate new team code (owner only)
 */
router.post(
  "/:brokerage_id/generate-team-code",
  authenticateToken,
  generateNewTeamCode,
);

export default router;
