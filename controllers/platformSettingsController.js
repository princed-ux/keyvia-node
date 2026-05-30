import { pool } from "../db.js";
import { logAdminAction } from "../utils/auditLogger.js";
import logger from "../utils/logger.js";

const normalizeRole = (role) => String(role || "").trim().toLowerCase();

const PLATFORM_SETTING_KEYS = [
  "maintenance_mode",
  "allow_new_registrations",
  "require_kyc",
  "max_listings_per_user",
  "default_currency",
  "platform_fee_percent",
  "platform_fee_cap",
  "free_listing_limit",
];

const SETTING_TYPES = {
  maintenance_mode: "boolean",
  allow_new_registrations: "boolean",
  require_kyc: "boolean",
  max_listings_per_user: "number",
  default_currency: "text",
  platform_fee_percent: "number",
  platform_fee_cap: "number",
  free_listing_limit: "number",
};

export const getPlatformSettings = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!["admin", "super_admin", "superadmin"].includes(role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const result = await pool.query(
      `SELECT key, value, type FROM platform_settings WHERE key = ANY($1)`,
      [PLATFORM_SETTING_KEYS],
    );

    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }

    return res.json({ success: true, settings });
  } catch (error) {
    logger.error("Error getting platform settings:", error);
    return res.status(500).json({ success: false, message: "Failed to load platform settings" });
  }
};

export const updatePlatformSetting = async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (!["admin", "super_admin", "superadmin"].includes(role)) {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { key, value } = req.body;

    if (!PLATFORM_SETTING_KEYS.includes(key)) {
      return res.status(400).json({ success: false, message: "Invalid platform setting key" });
    }

    await pool.query(
      `INSERT INTO platform_settings (key, value, type, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $5`,
      [
        key,
        String(value),
        SETTING_TYPES[key] || "text",
        "",
        req.user?.unique_id,
      ],
    );

    await logAdminAction(
      req.user?.unique_id,
      "platform_setting_updated",
      "platform_setting",
      key,
      { key, value },
    );

    return res.json({ success: true, message: "Platform setting updated" });
  } catch (error) {
    logger.error("Error updating platform setting:", error);
    return res.status(500).json({ success: false, message: "Failed to update platform setting" });
  }
};
