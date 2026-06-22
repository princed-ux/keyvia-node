import { pool } from "../db.js";

const AI_KEYS = new Set([
  "ai_auto_scan_listings",
  "ai_auto_scan_verifications",
  "ai_auto_approve_low_risk",
  "ai_auto_reject_high_risk",
  "ai_require_manual_review_medium_risk",
  "ai_auto_approve_threshold",
  "ai_auto_reject_threshold",
]);

// Numeric (score threshold) keys are parsed as numbers; everything else is boolean.
const NUMERIC_KEYS = new Set([
  "ai_auto_approve_threshold",
  "ai_auto_reject_threshold",
]);

const DEFAULTS = {
  ai_auto_scan_listings: false,
  ai_auto_scan_verifications: false,
  ai_auto_approve_low_risk: false,
  ai_auto_reject_high_risk: false,
  ai_require_manual_review_medium_risk: true,
  ai_auto_approve_threshold: 80,
  ai_auto_reject_threshold: 35,
};

export async function getAiSettings() {
  try {
    const result = await pool.query(
      `SELECT key, value FROM platform_settings WHERE key = ANY($1)`,
      [Array.from(AI_KEYS)],
    );

    const settings = { ...DEFAULTS };

    for (const row of result.rows) {
      if (NUMERIC_KEYS.has(row.key)) {
        const n = Number(row.value);
        settings[row.key] = Number.isFinite(n) ? n : DEFAULTS[row.key];
      } else if (row.value === "true") settings[row.key] = true;
      else if (row.value === "false") settings[row.key] = false;
      else settings[row.key] = row.value;
    }

    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}
