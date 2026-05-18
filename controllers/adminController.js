import { pool } from "../db.js";
import {
  analyzeVerification,
  analyzeVerificationBulk,
} from "../services/aiVerificationService.js";
import { emitUserNotification } from "../services/socketEmitter.js";
import { sendVerificationStatusEmail } from "../utils/emailService.js";

// =========================================================
// 1. GET PENDING IDENTITY VERIFICATIONS
// =========================================================
export const getPendingProfiles = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.unique_id,
        COALESCE(p.full_name, u.name) AS full_name,
        p.username,
        u.email,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        p.country,
        COALESCE(p.city, bp.brokerage_address) AS city,
        COALESCE(p.phone, u.phone) AS phone,
        LOWER(u.role::TEXT) AS role,
        u.license_number,
        COALESCE(bp.company_name, u.brokerage_name, u.name) AS company_name,
        COALESCE(bp.brokerage_address, u.brokerage_address) AS brokerage_address,
        COALESCE(bp.registration_number, u.license_number) AS registration_number,
        ap.experience_years AS experience,
        u.special_id,
        p.bio,
        u.created_at,
        u.updated_at,
        u.verification_status,
        u.is_verified,
        u.rejection_reason,
        COALESCE(u.license_document_url, u.identity_document_url) AS document_url
      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      LEFT JOIN brokerage_profiles bp
        ON bp.unique_id::text = u.unique_id::text
      LEFT JOIN agent_profiles ap
        ON ap.unique_id::text = u.unique_id::text
      WHERE u.verification_status = 'pending'
      ORDER BY u.created_at DESC
    `);

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("[GetPending] Error:", err);
    return res.status(500).json({ message: "Server Error" });
  }
};

// =========================================================
// 2. ANALYZE SINGLE VERIFICATION (ANALYSIS ONLY)
// =========================================================
export const analyzeAgentProfile = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        u.unique_id,
        COALESCE(p.full_name, u.name) AS full_name,
        p.username,
        u.email,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        p.country,
        COALESCE(p.city, bp.brokerage_address) AS city,
        COALESCE(p.phone, u.phone) AS phone,
        LOWER(u.role::TEXT) AS role,
        u.license_number,
        COALESCE(bp.company_name, u.brokerage_name, u.name) AS company_name,
        COALESCE(bp.brokerage_address, u.brokerage_address) AS brokerage_address,
        COALESCE(bp.registration_number, u.license_number) AS registration_number,
        ap.experience_years AS experience,
        u.special_id,
        p.bio,
        u.created_at,
        u.updated_at,
        u.verification_status,
        u.is_verified,
        u.rejection_reason,
        COALESCE(u.license_document_url, u.identity_document_url) AS document_url
      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      LEFT JOIN brokerage_profiles bp
        ON bp.unique_id::text = u.unique_id::text
      LEFT JOIN agent_profiles ap
        ON ap.unique_id::text = u.unique_id::text
      WHERE u.unique_id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const verification = result.rows[0];
    const report = await analyzeVerification(verification);

    // IMPORTANT: no status write here
    return res.json(report);
  } catch (err) {
    console.error("[AI Analyze] Error:", err);
    return res.status(500).json({ message: "Analysis Failed" });
  }
};

// =========================================================
// 3. BULK AI SCAN (ONLY THIS MAY AUTO-PROCESS)
// =========================================================
export const analyzeAllPendingProfiles = async (req, res) => {
  try {
    const pendingRes = await pool.query(`
      SELECT
        u.unique_id,
        COALESCE(p.full_name, u.name) AS full_name,
        p.username,
        u.email,
        COALESCE(p.avatar_url, u.avatar_url) AS avatar_url,
        p.country,
        COALESCE(p.city, bp.brokerage_address) AS city,
        COALESCE(p.phone, u.phone) AS phone,
        LOWER(u.role::TEXT) AS role,
        u.license_number,
        COALESCE(bp.company_name, u.brokerage_name, u.name) AS company_name,
        COALESCE(bp.brokerage_address, u.brokerage_address) AS brokerage_address,
        COALESCE(bp.registration_number, u.license_number) AS registration_number,
        ap.experience_years AS experience,
        u.special_id,
        p.bio,
        u.created_at,
        u.updated_at,
        u.verification_status,
        u.is_verified,
        u.rejection_reason,
        COALESCE(u.license_document_url, u.identity_document_url) AS document_url
      FROM users u
      LEFT JOIN profiles p
        ON p.unique_id::text = u.unique_id::text
      LEFT JOIN brokerage_profiles bp
        ON bp.unique_id::text = u.unique_id::text
      LEFT JOIN agent_profiles ap
        ON ap.unique_id::text = u.unique_id::text
      WHERE u.verification_status = 'pending'
    `);

    const profiles = pendingRes.rows;
    const reports = await analyzeVerificationBulk(profiles);

    let verified = 0;
    let rejected = 0;
    let remaining = 0;

    for (const report of reports) {
      const { unique_id, score, verdict, flags } = report;
      const profile = profiles.find(
        (item) => String(item.unique_id) === String(unique_id),
      );

      let newStatus = "pending";
      let reason = null;

      if (score < 50 || verdict === "Auto-Reject") {
        newStatus = "rejected";
        reason = `AI Auto-Reject: ${flags.join(", ") || "Low Confidence"}`;
        rejected++;
      } else if (score >= 90) {
        newStatus = "verified";
        verified++;
      } else {
        remaining++;
      }

      if (newStatus === "pending") {
        continue;
      }

      await pool.query(
        `
        UPDATE users
        SET
          verification_status = $1,
          is_verified = $2,
          is_verified_agent = CASE
            WHEN LOWER(role::TEXT) LIKE '%agent%' AND $2 = TRUE THEN TRUE
            ELSE FALSE
          END,
          rejection_reason = $3,
          updated_at = NOW()
        WHERE unique_id = $4
        `,
        [
          newStatus,
          newStatus === "verified",
          newStatus === "rejected" ? reason : null,
          unique_id,
        ]
      );

      const msg =
        newStatus === "verified"
          ? "Your identity has been verified. You can now access restricted features."
          : `Verification failed. Reason: ${reason}`;

      const notifResult = await pool.query(
        `
        INSERT INTO notifications (
          recipient_id,
          type,
          title,
          message,
          created_at
        )
        VALUES ($1, 'system', 'Verification Update', $2, NOW())
        RETURNING id, recipient_id, title, message, type, created_at
        `,
        [unique_id, msg]
      );

      emitUserNotification(req.io, unique_id, {
        title: notifResult.rows[0].title,
        message: notifResult.rows[0].message,
        type: "verification_update",
        link: null,
        created_at: notifResult.rows[0].created_at,
        verification_status: newStatus,
        is_verified: newStatus === "verified",
        rejection_reason: reason,
        meta: { reason },
      });

      sendVerificationStatusEmail({
        email: profile?.email,
        name: profile?.full_name,
        role: profile?.role || "account",
        status: newStatus,
        reason,
      }).catch((emailErr) => {
        console.warn("[Admin] Verification email skipped:", emailErr?.message);
      });
    }

    return res.json({
      success: true,
      verified,
      rejected,
      remaining,
    });
  } catch (err) {
    console.error("Bulk Analysis Error:", err);
    return res.status(500).json({ message: "Bulk scan failed" });
  }
};

// =========================================================
// 4. MANUAL VERIFY / REJECT
// =========================================================
export const updateProfileStatus = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { status, reason } = req.body;

    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    await client.query("BEGIN");

    const profileCheck = await client.query(
      `
      SELECT
        unique_id,
        email,
        name,
        LOWER(role::TEXT) AS role,
        verification_status,
        is_verified
      FROM users
      WHERE unique_id = $1
      LIMIT 1
      `,
      [id]
    );

    if (!profileCheck.rows.length) {
      throw new Error("Profile not found");
    }

    const { role, email, name } = profileCheck.rows[0];
    const isVerified = status === "verified";
    const rejectionReason =
      status === "rejected"
        ? reason || "Verification requirements were not met."
        : null;

    await client.query(
      `
      UPDATE users
      SET
        verification_status = $1,
        is_verified = $2,
        is_verified_agent = CASE
          WHEN LOWER(role::TEXT) LIKE '%agent%' AND $2 = TRUE THEN TRUE
          ELSE FALSE
        END,
        rejection_reason = $3,
        updated_at = NOW()
      WHERE unique_id = $4
      `,
      [status, isVerified, rejectionReason, id]
    );

    const oldStatus = profileCheck.rows[0].verification_status;
    const oldIsVerified = profileCheck.rows[0].is_verified;

    await client.query(
      `
      INSERT INTO verification_history (user_id, changed_by, old_status, new_status, old_is_verified, new_is_verified, rejection_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [id, req.user?.unique_id, oldStatus, status, oldIsVerified, isVerified, rejectionReason]
    );

    const msg =
      status === "verified"
        ? `Congratulations! Your ${role} identity has been verified.`
        : `Verification Rejected: ${rejectionReason}`;

    const notifResult = await client.query(
      `
      INSERT INTO notifications (
        recipient_id,
        type,
        title,
        message,
        created_at
      )
      VALUES ($1, 'system', 'Verification Update', $2, NOW())
      RETURNING id, recipient_id, title, message, type, created_at
      `,
      [id, msg]
    );

    await client.query("COMMIT");

    emitUserNotification(req.io, id, {
      title: notifResult.rows[0].title,
      message: notifResult.rows[0].message,
      type: "verification_update",
      link: null,
      created_at: notifResult.rows[0].created_at,
      verification_status: status,
      is_verified: isVerified,
      rejection_reason: rejectionReason,
      meta: { reason: rejectionReason },
    });

    sendVerificationStatusEmail({
      email,
      name,
      role,
      status,
      reason: rejectionReason,
    }).catch((emailErr) => {
      console.warn("[Admin] Verification email skipped:", emailErr?.message);
    });

    return res.json({
      success: true,
      message: `Profile ${status}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Verification Update Error:", err);
    return res.status(500).json({ message: "Update Failed" });
  } finally {
    client.release();
  }
};
