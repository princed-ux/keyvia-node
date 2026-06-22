import express from "express";
import {
  authenticateAndAttachUser,
  optionalAuth,
} from "../middleware/authMiddleware.js";
import {
  getProfile,
  updateProfile,
  updateProfileAvatar,
  updateProfileCover,
  getPublicProfile,
  getPublicAgentProfile,
  getSocialOwnerProfile,
  getSocialAgentProfile,
  getSocialBrokerageProfile,
  getSocialAgencyAgentProfile,
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

router.put(
  "/cover",
  authenticateAndAttachUser,
  ensureProfile,
  upload.single("cover"),
  updateProfileCover,
);

// =====================================================
// PUBLIC PROFILE
// Base path: /api/profile/public/:username
// Example: /api/profile/public/prince
// Example: /api/profile/public/@prince
// =====================================================

router.get("/public/:username", optionalAuth, getPublicProfile);

// Role-specific public social aliases. These reuse the same public-safe
// resolver and keep the current /public and /agent routes compatible.
router.get("/social/owner/:identifier", optionalAuth, getSocialOwnerProfile);
router.get("/social/agent/:identifier", optionalAuth, getSocialAgentProfile);
router.get("/social/brokerage/:identifier", optionalAuth, getSocialBrokerageProfile);
router.get(
  "/social/agency-agent/:identifier",
  optionalAuth,
  getSocialAgencyAgentProfile,
);

// =====================================================
// PUBLIC AGENT PROFILE
// Base path: /api/profile/agent/:unique_id
// Example: /api/profile/agent/uuid-here
// Example: /api/profile/agent/@agentusername
// =====================================================

router.get("/agent/:unique_id", optionalAuth, getPublicAgentProfile);

export default router;
