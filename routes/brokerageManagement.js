import express from "express";
import { authenticateToken } from "../middleware/authMiddleware.js";

import {
  createBrokerage,
  generateNewTeamCode,
  verifyTeamCode,
  getBrokerage,
  getBrokerageAgents,
  removeBrokerageAgent,
  updateBrokerage,
} from "../controllers/brokerageController.js";

const router = express.Router();

/**
 * PUBLIC ROUTES
 */

// POST /api/brokerage/manage/verify-team-code
router.post("/verify-team-code", verifyTeamCode);

// GET /api/brokerage/manage/public/:brokerage_id
router.get("/public/:brokerage_id", getBrokerage);

// GET /api/brokerage/manage/public/:brokerage_id/agents
router.get("/public/:brokerage_id/agents", getBrokerageAgents);

/**
 * PROTECTED ROUTES
 */

// POST /api/brokerage/manage/create
router.post("/create", authenticateToken, createBrokerage);

// GET /api/brokerage/manage/agents
// Brokerage owner gets their own connected agents.
router.get("/agents", authenticateToken, getBrokerageAgents);

// DELETE /api/brokerage/manage/agents/:agentId
// Disconnects agent from brokerage. Does not delete agent account.
router.delete("/agents/:agentId", authenticateToken, removeBrokerageAgent);

// GET /api/brokerage/manage/:brokerage_id/agents
// Optional compatibility route if another page still uses brokerage_id.
router.get("/:brokerage_id/agents", authenticateToken, getBrokerageAgents);

// PUT /api/brokerage/manage/:brokerage_id
router.put("/:brokerage_id", authenticateToken, updateBrokerage);

// POST /api/brokerage/manage/:brokerage_id/generate-team-code
router.post(
  "/:brokerage_id/generate-team-code",
  authenticateToken,
  generateNewTeamCode
);

export default router;