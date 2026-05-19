// controllers/onboardingController.js
import { pool } from "../db.js";
import { createNotification } from "./notificationsController.js";
import { sendVerificationSubmittedEmail } from "../utils/emailService.js";
import { analyzeVerification } from "../services/aiVerificationService.js";
import { getAiSettings } from "../services/aiSettingsService.js";

/**
 * GET user's onboarding status
 */
export const getOnboardingStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT id, user_id, current_step, basic_info_complete, documents_uploaded, 
              identity_verified, is_submitted, status, agent_type, rejection_reason,
              created_at, updated_at, completed_at
       FROM onboarding_status
       WHERE user_id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      // Create default onboarding status if it doesn't exist
      const newStatus = await pool.query(
        `INSERT INTO onboarding_status (user_id, current_step, status)
         VALUES ($1, 1, 'in_progress')
         RETURNING id, user_id, current_step, basic_info_complete, documents_uploaded,
                   identity_verified, is_submitted, status, agent_type, created_at, updated_at`,
        [userId],
      );
      return res.json({ success: true, status: newStatus.rows[0] });
    }

    res.json({ success: true, status: result.rows[0] });
  } catch (error) {
    console.error("[GetOnboardingStatus] Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch onboarding status" });
  }
};

/**
 * UPDATE onboarding step
 */
export const updateOnboardingStep = async (req, res) => {
  try {
    const userId = req.user.id;
    const { current_step, step_data } = req.body;

    if (!current_step || ![1, 2, 3, 4].includes(current_step)) {
      return res.status(400).json({ success: false, message: "Invalid step" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Determine which fields to update based on step
      let updateFields = "current_step = $2";
      const params = [userId, current_step];

      if (current_step === 1) {
        updateFields += ", basic_info_complete = true";
      } else if (current_step === 2) {
        updateFields += ", documents_uploaded = true";
      } else if (current_step === 3) {
        updateFields += ", identity_verified = true";
      } else if (current_step === 4) {
        updateFields += ", is_submitted = true, status = $3";
        params.push("submitted");
      }

      const result = await client.query(
        `UPDATE onboarding_status
         SET ${updateFields}, updated_at = NOW()
         WHERE user_id = $1
         RETURNING id, user_id, current_step, basic_info_complete, documents_uploaded,
                   identity_verified, is_submitted, status, updated_at`,
        params,
      );

      if (result.rows.length === 0) {
        throw new Error("Onboarding status not found");
      }

      await client.query("COMMIT");

      // Background AI verification scan if step 4 submission
      if (current_step === 4) {
        setImmediate(async () => {
          try {
            const aiSettings = await getAiSettings();
            if (aiSettings.ai_auto_scan_verifications) {
              const userProfile = await pool.query(
                `SELECT u.unique_id, u.name AS full_name, u.email, u.role, p.avatar_url, p.legal_document_url AS document_url
                 FROM users u LEFT JOIN profiles p ON p.unique_id = u.unique_id WHERE u.id = $1`,
                [userId],
              );
              if (userProfile.rows[0]) {
                await analyzeVerification(userProfile.rows[0]);
              }
            }
          } catch {
            // AI verification scan must never block submission
          }
        });
      }

      res.json({
        success: true,
        message: `Step ${current_step} completed`,
        status: result.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[UpdateOnboardingStep] Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to update onboarding step" });
  }
};

/**
 * SUBMIT onboarding for review
 */
export const submitOnboarding = async (req, res) => {
  try {
    const userId = req.user.id;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Update onboarding status
      const result = await client.query(
        `UPDATE onboarding_status
         SET is_submitted = true, 
             submitted_at = NOW(), 
             status = 'under_review',
             current_step = 4,
             updated_at = NOW()
         WHERE user_id = $1
         RETURNING id, status, submitted_at`,
        [userId],
      );

      if (result.rows.length === 0) {
        throw new Error("Onboarding status not found");
      }

      // Create notification for admin
      const userResult = await client.query(
        `
        SELECT
          id,
          unique_id,
          email,
          COALESCE(name, email) AS full_name,
          role
        FROM users
        WHERE id = $1
        `,
        [userId],
      );

      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        const notifMessage = `New ${user.role} verification request from ${user.full_name} (${user.email})`;

        // Create notification for all super admins
        await client.query(
          `INSERT INTO notifications (recipient_id, type, title, message, related_resource_type, related_resource_id, action_url)
           SELECT unique_id, 'account_approval', 'New Verification Request', $1, 'user', $2, '/admin/approvals'
           FROM users
           WHERE is_super_admin = true`,
          [notifMessage, user.unique_id],
        );

        await createNotification({
          client,
          io: req.io,
          recipientId: user.unique_id,
          type: "verification_submitted",
          title: "Verification submitted",
          message:
            "Your account verification is under review. We will notify you once it is approved or if anything needs attention.",
          entityType: "user",
          entityId: user.unique_id,
          actionUrl: "/dashboard",
          actionLabel: "Open Dashboard",
        }).catch((notificationErr) => {
          console.warn(
            "[SubmitOnboarding] Review notification skipped:",
            notificationErr?.message,
          );
        });

        sendVerificationSubmittedEmail({
          email: user.email,
          name: user.full_name,
          role: user.role,
        }).catch((emailErr) => {
          console.warn("[SubmitOnboarding] Review email skipped:", emailErr?.message);
        });
      }

      // Background AI verification scan if enabled
      setImmediate(async () => {
        try {
          const aiSettings = await getAiSettings();
          if (aiSettings.ai_auto_scan_verifications) {
            const userProfile = await pool.query(
              `SELECT u.unique_id, u.name AS full_name, u.email, u.role, p.avatar_url, p.legal_document_url AS document_url
               FROM users u LEFT JOIN profiles p ON p.unique_id = u.unique_id WHERE u.id = $1`,
              [userId],
            );
            if (userProfile.rows[0]) {
              await analyzeVerification(userProfile.rows[0]);
            }
          }
        } catch {
          // AI verification scan must never block submission
        }
      });

      await client.query("COMMIT");

      res.json({
        success: true,
        message:
          "Your onboarding has been submitted for review. We will review your documents and get back to you soon.",
        status: result.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[SubmitOnboarding] Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to submit onboarding" });
  }
};

/**
 * GET onboarding progress stats (for dashboard)
 */
export const getOnboardingProgress = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT 
        CASE WHEN basic_info_complete THEN 25 ELSE 0 END +
        CASE WHEN documents_uploaded THEN 25 ELSE 0 END +
        CASE WHEN identity_verified THEN 25 ELSE 0 END +
        CASE WHEN is_submitted THEN 25 ELSE 0 END as percentage,
        current_step,
        status,
        basic_info_complete,
        documents_uploaded,
        identity_verified,
        is_submitted
       FROM onboarding_status
       WHERE user_id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.json({ success: true, percentage: 0, current_step: 1 });
    }

    res.json({ success: true, ...result.rows[0] });
  } catch (error) {
    console.error("[GetOnboardingProgress] Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch progress" });
  }
};
