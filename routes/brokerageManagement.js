import express from "express";
import {
  authenticateToken,
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

// PUT /api/brokerage/manage/:brokerage_id
router.put("/:brokerage_id", authenticateToken, updateBrokerage);

// POST /api/brokerage/manage/:brokerage_id/generate-team-code
router.post(
  "/:brokerage_id/generate-team-code",
  authenticateToken,
  generateNewTeamCode
);

export default router;