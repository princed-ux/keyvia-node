import express from "express";
import {
  getPendingProfiles,
  analyzeAgentProfile,
  analyzeAllPendingProfiles,
  updateProfileStatus,
  getApprovalsUsers,
  getApprovalsBrokerages,
  getFlaggedListings,
  getAdminStats,
  getAdminAnalytics,
  patchApprovalUser,
  deleteFlaggedListing,
  getAiModerationSettings,
  updateAiModerationSetting,
  getNotificationSettings,
  updateNotificationSetting,
  getSecuritySettings,
  updateSecuritySetting,
} from "../controllers/adminController.js";

import {
  authenticate,
  verifyAdmin,
} from "../middleware/authMiddleware.js";

import {
  getAuditLogs,
  getAuditLogSummary,
} from "../controllers/auditLogsController.js";

import {
  getPlatformSettings,
  updatePlatformSetting,
} from "../controllers/platformSettingsController.js";

const router = express.Router();

// --- Verification / KYC ---
router.get("/profiles/pending", authenticate, verifyAdmin, getPendingProfiles);
router.post("/profiles/:id/analyze", authenticate, verifyAdmin, analyzeAgentProfile);
router.put("/profiles/:id/status", authenticate, verifyAdmin, updateProfileStatus);
router.post("/profiles/analyze-all", authenticate, verifyAdmin, analyzeAllPendingProfiles);

// --- Dashboard ---
router.get("/approvals/users", authenticate, verifyAdmin, getApprovalsUsers);
router.get("/approvals/brokerages", authenticate, verifyAdmin, getApprovalsBrokerages);
router.get("/listings/flagged", authenticate, verifyAdmin, getFlaggedListings);
router.get("/stats", authenticate, verifyAdmin, getAdminStats);
router.get("/analytics", authenticate, verifyAdmin, getAdminAnalytics);
router.patch("/approvals/users/:userId", authenticate, verifyAdmin, patchApprovalUser);
router.delete("/listings/:listingId", authenticate, verifyAdmin, deleteFlaggedListing);

// --- AI Moderation Settings ---
router.get("/ai-settings", authenticate, verifyAdmin, getAiModerationSettings);
router.put("/ai-settings", authenticate, verifyAdmin, updateAiModerationSetting);

// --- Audit Logs ---
router.get("/audit-logs", authenticate, verifyAdmin, getAuditLogs);
router.get("/audit-logs/summary", authenticate, verifyAdmin, getAuditLogSummary);

// --- Notification Settings ---
router.get("/settings/notifications", authenticate, verifyAdmin, getNotificationSettings);
router.put("/settings/notifications", authenticate, verifyAdmin, updateNotificationSetting);

// --- Security Settings ---
router.get("/settings/security", authenticate, verifyAdmin, getSecuritySettings);
router.put("/settings/security", authenticate, verifyAdmin, updateSecuritySetting);

// --- Platform Settings ---
router.get("/settings/platform", authenticate, verifyAdmin, getPlatformSettings);
router.put("/settings/platform", authenticate, verifyAdmin, updatePlatformSetting);

export default router;
