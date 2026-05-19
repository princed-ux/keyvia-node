import { pool } from "../db.js";

const AI_KEYS = new Set([
  "ai_auto_scan_listings",
  "ai_auto_scan_verifications",
  "ai_auto_approve_low_risk",
  "ai_auto_reject_high_risk",
  "ai_require_manual_review_medium_risk",
]);

const DEFAULTS = {
  ai_auto_scan_listings: false,
  ai_auto_scan_verifications: false,
  ai_auto_approve_low_risk: true,
  ai_auto_reject_high_risk: true,
  ai_require_manual_review_medium_risk: true,
};

export async function getAiSettings() {
  try {
    const result = await pool.query(
      `SELECT key, value FROM platform_settings WHERE key = ANY($1)`,
      [Array.from(AI_KEYS)],
    );

    const settings = { ...DEFAULTS };

    for (const row of result.rows) {
      if (row.value === "true") settings[row.key] = true;
      else if (row.value === "false") settings[row.key] = false;
      else settings[row.key] = row.value;
    }

    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}
