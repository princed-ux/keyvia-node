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

// Update core account info (name, phone, bio) — writes directly to users table
router.put("/profile-info", authenticateToken, async (req, res) => {
  try {
    const { name, phone, bio } = req.body;
    const uid = req.user.unique_id;
    const updates = [];
    const values = [];

    if (name !== undefined) {
      values.push(String(name || "").trim());
      updates.push(`name = $${values.length}`);
    }
    if (phone !== undefined) {
      values.push(String(phone || "").trim() || null);
      updates.push(`phone = $${values.length}`);
    }
    if (bio !== undefined) {
      values.push(String(bio || "").trim() || null);
      updates.push(`bio = $${values.length}`);
    }

    if (!updates.length) {
      return res.status(400).json({ success: false, message: "No fields to update." });
    }

    values.push(uid);
    await pool.query(
      `UPDATE users SET ${updates.join(", ")}, updated_at = NOW() WHERE unique_id::text = $${values.length}::text`,
      values,
    );

    const result = await pool.query(
      "SELECT name, phone, bio FROM users WHERE unique_id::text = $1::text LIMIT 1",
      [uid],
    );

    return res.json({ success: true, message: "Profile info updated.", user: result.rows[0] });
  } catch (err) {
    console.error("[Settings] profile-info update error:", err);
    return res.status(500).json({ success: false, message: "Could not update profile info." });
  }
});

// List active sessions for this user
router.get("/sessions", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, created_at, last_used_at, device_info, ip_address
       FROM refresh_tokens
       WHERE user_id::text = $1::text
       ORDER BY COALESCE(last_used_at, created_at) DESC`,
      [req.user.unique_id],
    );

    return res.json({ success: true, sessions: result.rows });
  } catch (err) {
    // If last_used_at / device_info columns don't exist, return minimal data
    try {
      const fallback = await pool.query(
        "SELECT id, created_at FROM refresh_tokens WHERE user_id::text = $1::text ORDER BY created_at DESC",
        [req.user.unique_id],
      );
      return res.json({ success: true, sessions: fallback.rows });
    } catch {
      return res.status(500).json({ success: false, message: "Could not fetch sessions." });
    }
  }
});

// Revoke a specific session
router.delete("/sessions/:id", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM refresh_tokens WHERE id = $1 AND user_id::text = $2::text",
      [req.params.id, req.user.unique_id],
    );
    return res.json({ success: true, message: "Session revoked." });
  } catch (err) {
    console.error("[Settings] revoke session error:", err);
    return res.status(500).json({ success: false, message: "Could not revoke session." });
  }
});

// Revoke all OTHER sessions (keep current)
router.delete("/sessions", authenticateToken, async (req, res) => {
  try {
    const currentToken = req.cookies?.refreshToken;
    if (currentToken) {
      await pool.query(
        "DELETE FROM refresh_tokens WHERE user_id::text = $1::text AND token != $2",
        [req.user.unique_id, currentToken],
      );
    } else {
      await pool.query(
        "DELETE FROM refresh_tokens WHERE user_id::text = $1::text",
        [req.user.unique_id],
      );
    }
    return res.json({ success: true, message: "All other sessions revoked." });
  } catch (err) {
    console.error("[Settings] revoke all sessions error:", err);
    return res.status(500).json({ success: false, message: "Could not revoke sessions." });
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
