import express from "express";
import bcrypt from "bcrypt";
import { pool } from "../db.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = express.Router();

const SECTION_COLUMNS = {
  account: "account_preferences",
  preferences: "account_preferences",
  notifications: "notification_preferences",
  listings: "listing_preferences",
  appearance: "appearance_preferences",
  security: "security_preferences",
  language: "language_region",
  "language-region": "language_region",
};

let settingsTableReady = false;

const ensureSettingsTable = async () => {
  if (settingsTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id UUID PRIMARY KEY REFERENCES users(unique_id) ON DELETE CASCADE,
      account_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      listing_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      appearance_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      security_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
      language_region JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  settingsTableReady = true;
};

const getUserSettings = async (userId) => {
  await ensureSettingsTable();

  const result = await pool.query(
    `
    INSERT INTO user_settings (user_id)
    VALUES ($1::uuid)
    ON CONFLICT (user_id) DO UPDATE SET updated_at = user_settings.updated_at
    RETURNING
      account_preferences,
      notification_preferences,
      listing_preferences,
      appearance_preferences,
      security_preferences,
      language_region,
      updated_at
    `,
    [userId],
  );

  return result.rows[0];
};

const normalizePayload = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body;
};

router.get("/", authenticateToken, async (req, res) => {
  try {
    const settings = await getUserSettings(req.user.unique_id);

    return res.json({
      success: true,
      settings,
    });
  } catch (err) {
    console.error("[Settings] Load settings error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load settings.",
    });
  }
});

router.put("/password", authenticateToken, async (req, res) => {
  try {
    const currentPassword = String(req.body?.current_password || "");
    const newPassword = String(req.body?.new_password || "");

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required.",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters.",
      });
    }

    const userResult = await pool.query(
      `
      SELECT password
      FROM users
      WHERE unique_id::text = $1::text
      LIMIT 1
      `,
      [req.user.unique_id],
    );

    const passwordHash = userResult.rows[0]?.password;

    if (!passwordHash) {
      return res.status(400).json({
        success: false,
        message:
          "Password login is not configured for this account. Use password reset or your sign-in provider.",
      });
    }

    const valid = await bcrypt.compare(currentPassword, passwordHash);

    if (!valid) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect.",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      `
      UPDATE users
      SET password = $1
      WHERE unique_id::text = $2::text
      `,
      [hashedPassword, req.user.unique_id],
    );

    return res.json({
      success: true,
      message: "Password updated successfully.",
    });
  } catch (err) {
    console.error("[Settings] Password update error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not update password.",
    });
  }
});

router.get("/:section", authenticateToken, async (req, res) => {
  try {
    const column = SECTION_COLUMNS[req.params.section];

    if (!column) {
      return res.status(404).json({
        success: false,
        message: "Settings section not found.",
      });
    }

    const settings = await getUserSettings(req.user.unique_id);

    return res.json({
      success: true,
      section: req.params.section,
      settings: settings[column] || {},
      updated_at: settings.updated_at,
    });
  } catch (err) {
    console.error("[Settings] Load section error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not load settings.",
    });
  }
});

router.put("/:section", authenticateToken, async (req, res) => {
  try {
    const column = SECTION_COLUMNS[req.params.section];

    if (!column) {
      return res.status(404).json({
        success: false,
        message: "Settings section not found.",
      });
    }

    await ensureSettingsTable();

    const payload = normalizePayload(req.body);
    const result = await pool.query(
      `
      INSERT INTO user_settings (user_id, ${column}, updated_at)
      VALUES ($1::uuid, $2::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        ${column} = EXCLUDED.${column},
        updated_at = NOW()
      RETURNING ${column} AS settings, updated_at
      `,
      [req.user.unique_id, JSON.stringify(payload)],
    );

    return res.json({
      success: true,
      section: req.params.section,
      settings: result.rows[0]?.settings || {},
      updated_at: result.rows[0]?.updated_at || null,
      message: "Settings saved.",
    });
  } catch (err) {
    console.error("[Settings] Save section error:", err);
    return res.status(500).json({
      success: false,
      message: "Could not save settings.",
    });
  }
});

export default router;
