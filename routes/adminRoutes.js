import express from "express";
import { pool } from "../db.js";
import {
  getPendingProfiles,
  analyzeAgentProfile,
  analyzeAllPendingProfiles,
  analyzeListingAdmin,
  analyzeAllPendingListings,
  getAutomationStats,
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

import { createNotification } from "../controllers/notificationsController.js";

import {
  getAuditLogs,
  getAuditLogSummary,
} from "../controllers/auditLogsController.js";

import {
  getPlatformSettings,
  updatePlatformSetting,
} from "../controllers/platformSettingsController.js";

import {
  getAllSettings,
  updateSetting,
} from "../controllers/settingsController.js";

import { adminReauth } from "../controllers/authController.js";

const router = express.Router();

// --- Unified settings (B1): one surface over the settings service ---
router.get("/settings", authenticate, verifyAdmin, getAllSettings);
router.put("/settings", authenticate, verifyAdmin, updateSetting);

// --- Step-up re-auth (B2): exchange password for a short-lived reauth token ---
router.post("/reauth", authenticate, verifyAdmin, adminReauth);

// --- Verification / KYC ---
router.get("/profiles/pending", authenticate, verifyAdmin, getPendingProfiles);
router.post("/profiles/:id/analyze", authenticate, verifyAdmin, analyzeAgentProfile);
router.put("/profiles/:id/status", authenticate, verifyAdmin, updateProfileStatus);
router.post("/profiles/analyze-all", authenticate, verifyAdmin, analyzeAllPendingProfiles);

// --- Listing AI analysis ---
router.post("/listings/:id/analyze", authenticate, verifyAdmin, analyzeListingAdmin);
router.post("/listings/analyze-all", authenticate, verifyAdmin, analyzeAllPendingListings);

// --- Automation stats ---
router.get("/automation/stats", authenticate, verifyAdmin, getAutomationStats);

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

// ─── Admin Notification Sender ──────────────────────────────────────────────

// POST /api/admin/notifications/send — send a notification to a specific user
router.post("/notifications/send", authenticate, verifyAdmin, async (req, res) => {
  const { recipient_identifier, title, message, type, action_url, action_label } = req.body;
  const adminId = req.user?.unique_id;

  if (!recipient_identifier || !title || !message) {
    return res.status(400).json({ success: false, message: "recipient_identifier, title, and message are required." });
  }

  try {
    // Look up the user by unique_id or email
    const userRes = await pool.query(
      `SELECT unique_id, name, email FROM users
       WHERE unique_id::text = $1 OR LOWER(email) = LOWER($1)
       LIMIT 1`,
      [String(recipient_identifier).trim()],
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const recipient = userRes.rows[0];

    await createNotification({
      recipientId: recipient.unique_id,
      senderId: adminId,
      type: type || "admin_notice",
      title,
      message,
      actionUrl: action_url || null,
      actionLabel: action_label || null,
      io: req.io,
    });

    // Audit log the action
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, target_type, target_id, details, created_at)
       VALUES ($1, 'send_notification', 'user', $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [adminId, recipient.unique_id, JSON.stringify({ title, message, type })],
    ).catch(() => {}); // Non-fatal if audit_logs schema differs

    return res.json({
      success: true,
      message: `Notification sent to ${recipient.name || recipient.email}.`,
      recipient: { unique_id: recipient.unique_id, name: recipient.name, email: recipient.email },
    });
  } catch (err) {
    console.error("[Admin] send notification error:", err.message);
    return res.status(500).json({ success: false, message: "Could not send notification." });
  }
});

// POST /api/admin/notifications/broadcast-role — send to all users of a role
router.post("/notifications/broadcast-role", authenticate, verifyAdmin, async (req, res) => {
  const { role, title, message, type, action_url, action_label } = req.body;
  const adminId = req.user?.unique_id;

  if (!role || !title || !message) {
    return res.status(400).json({ success: false, message: "role, title, and message are required." });
  }

  const ALLOWED_ROLES = ["buyer", "agent", "owner", "brokerage_owner", "admin"];
  if (!ALLOWED_ROLES.includes(role.toLowerCase())) {
    return res.status(400).json({ success: false, message: "Invalid role. Allowed: buyer, agent, owner, brokerage_owner, admin" });
  }

  try {
    const usersRes = await pool.query(
      `SELECT unique_id FROM users WHERE LOWER(role::text) = LOWER($1) AND is_banned = false LIMIT 500`,
      [role],
    );

    const recipients = usersRes.rows;
    if (!recipients.length) {
      return res.json({ success: true, message: "No users found for this role.", sent: 0 });
    }

    // Send in batches, non-blocking
    let sent = 0;
    for (const user of recipients) {
      try {
        await createNotification({
          recipientId: user.unique_id,
          senderId: adminId,
          type: type || "admin_notice",
          title,
          message,
          actionUrl: action_url || null,
          actionLabel: action_label || null,
          io: req.io,
        });
        sent++;
      } catch {}
    }

    return res.json({ success: true, message: `Notification sent to ${sent} users with role: ${role}.`, sent });
  } catch (err) {
    console.error("[Admin] broadcast-role error:", err.message);
    return res.status(500).json({ success: false, message: "Broadcast failed." });
  }
});

export default router;
