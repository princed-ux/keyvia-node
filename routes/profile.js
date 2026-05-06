import express from "express";
import { authenticateAndAttachUser } from "../middleware/authMiddleware.js";
import {
  getProfile,
  updateProfile,
  updateProfileAvatar,
  getPublicProfile,
  getPublicAgentProfile,
} from "../controllers/profileController.js";

import { upload } from "../middleware/upload.js";
import { ensureProfile } from "../middleware/ensureProfile.js";

const router = express.Router();

// =====================================================
// PRIVATE PROFILE
// Base path: /api/profile
// =====================================================

router.get("/", authenticateAndAttachUser, ensureProfile, getProfile);

router.put("/", authenticateAndAttachUser, ensureProfile, updateProfile);

// =====================================================
// PROFILE AVATAR / LOGO
// Base path: /api/profile/avatar
// =====================================================

router.put(
  "/avatar",
  authenticateAndAttachUser,
  ensureProfile,
  upload.single("avatar"),
  updateProfileAvatar,
);

// =====================================================
// PUBLIC PROFILE
// Base path: /api/profile/public/:username
// Example: /api/profile/public/prince
// Example: /api/profile/public/@prince
// =====================================================

router.get("/public/:username", getPublicProfile);

// =====================================================
// PUBLIC AGENT PROFILE
// Base path: /api/profile/agent/:unique_id
// Example: /api/profile/agent/uuid-here
// Example: /api/profile/agent/@agentusername
// =====================================================

router.get("/agent/:unique_id", getPublicAgentProfile);

export default router;