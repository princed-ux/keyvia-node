import express from "express";
import {
  getPendingProfiles,
  analyzeAgentProfile,
  analyzeAllPendingProfiles,
  updateProfileStatus,
} from "../controllers/adminController.js";

import {
  authenticate,
  verifyAdmin,
} from "../middleware/authMiddleware.js";

const router = express.Router();

router.get(
  "/profiles/pending",
  authenticate,
  verifyAdmin,
  getPendingProfiles
);

router.post(
  "/profiles/:id/analyze",
  authenticate,
  verifyAdmin,
  analyzeAgentProfile
);

router.put(
  "/profiles/:id/status",
  authenticate,
  verifyAdmin,
  updateProfileStatus
);

router.post(
  "/profiles/analyze-all",
  authenticate,
  verifyAdmin,
  analyzeAllPendingProfiles
);

export default router;