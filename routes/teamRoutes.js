// keyvia-node/routes/teamRoutes.js
// ============================================================================
// BROKERAGE TEAM MANAGEMENT
// ============================================================================

import express from "express";
import {
  authenticateToken,
  verifyAdmin,
} from "../middleware/authMiddleware.js";
import {
  removeAgent,
  postTeamMessage,
  getTeamMessages,
  getTeamMembers,
  getTeamStats,
} from "../controllers/brokerageTeamController.js";

const router = express.Router();

/**
 * POST /api/team/remove-agent/:agent_id
 * Brokerage owner removes an agent from their team
 */
router.post("/remove-agent/:agent_id", authenticateToken, removeAgent);

/**
 * POST /api/team/messages
 * Post a message to team group chat
 */
router.post("/messages", authenticateToken, postTeamMessage);

/**
 * GET /api/team/messages
 * Get team chat history (paginated)
 */
router.get("/messages", authenticateToken, getTeamMessages);

/**
 * GET /api/team/members
 * Get all team members (agents + owner)
 */
router.get("/members", authenticateToken, getTeamMembers);

/**
 * GET /api/team/stats
 * Get brokerage team statistics
 */
router.get("/stats", authenticateToken, getTeamStats);

export default router;
