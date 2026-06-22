// controllers/settingsController.js
// ============================================================================
// Unified settings API (B1). One endpoint surface over the settings service.
//   GET  /api/admin/settings        -> grouped settings + values + enforcement
//   PUT  /api/admin/settings        -> { key, value } validated + audited update
// Admin and super admin can read/update (route already guards with verifyAdmin).
// ============================================================================

import { getGroupedSettings, setValue } from "../services/settingsService.js";
import logger from "../utils/logger.js";

export const getAllSettings = async (req, res) => {
  try {
    const role = req.user?.is_super_admin ? "super_admin" : req.user?.role || "admin";
    const groups = await getGroupedSettings(role);
    return res.json({
      success: true,
      groups,
      role,
      is_super_admin: Boolean(req.user?.is_super_admin) || role === "super_admin",
    });
  } catch (err) {
    logger.error("getAllSettings error:", err);
    return res.status(500).json({ success: false, message: "Failed to load settings" });
  }
};

export const updateSetting = async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ success: false, message: "key is required" });

    const result = await setValue(key, value, req);
    return res.json({ success: true, message: "Setting updated", ...result });
  } catch (err) {
    if (err.statusCode === 400 || err.statusCode === 403) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    logger.error("updateSetting error:", err);
    return res.status(500).json({ success: false, message: "Failed to update setting" });
  }
};
