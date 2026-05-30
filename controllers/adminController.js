import { pool } from "../db.js";
import {
  analyzeVerification,
  analyzeVerificationBulk,
} from "../services/aiVerificationService.js";
import { emitUserNotification } from "../services/socketEmitter.js";
import { sendVerificationStatusEmail } from "../utils/emailService.js";
import { getAiSettings } from "../services/aiSettingsService.js";

const tableExists = async (tableName) => {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName],
  );
  return result.rows.length > 0;
};

// =========================================================
// 1. GET PENDING IDENTITY VERIFICATIONS
// =========================================================
const PROFILE_STATUSES = ["pending", "verified", "rejected"];

export const getPendingProfiles = async (req, res) => {
  try {
    const status = String(req.query.status || "pending").toLowerCase();
    const statusFilter = status === "all" ? PROFILE_STATUSES : [status];
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const offset = Math.max((parseInt(req.query.page, 10) || 1) - 1, 0) * limit;

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
      WHERE u.verification_status::text = ANY($1::text[])
      ORDER BY u.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [statusFilter, limit, offset],
    );

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
    const aiSettings = await getAiSettings();

    const shouldAutoApprove = aiSettings.ai_auto_approve_low_risk !== false;
    const shouldAutoReject = aiSettings.ai_auto_reject_high_risk !== false;
    const requireManualReview = aiSettings.ai_require_manual_review_medium_risk !== false;

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

      const safeVerdicts = ["safe to approve", "verified", "auto-approve"];
      const rejectVerdicts = ["rejected", "auto-reject", "auto rejected", "reject"];

      if ((safeVerdicts.includes(verdict?.toLowerCase()) || score >= 80) && shouldAutoApprove) {
        newStatus = "verified";
        verified++;
      } else if ((rejectVerdicts.includes(verdict?.toLowerCase()) || score <= 35) && shouldAutoReject) {
        newStatus = "rejected";
        reason = `AI Auto-Reject: ${flags.join(", ") || "Low Confidence"}`;
        rejected++;
      } else if (requireManualReview) {
        remaining++;
      } else if (safeVerdicts.includes(verdict?.toLowerCase()) || score >= 80) {
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

// =========================================================
// 5. GET APPROVALS USERS (Dashboard)
// =========================================================
export const getApprovalsUsers = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.unique_id AS id,
        COALESCE(p.full_name, u.name) AS full_name,
        u.email,
        LOWER(u.role::TEXT) AS role,
        u.created_at,
        CASE
          WHEN u.is_verified = TRUE THEN 'Approved'
          WHEN u.verification_status = 'rejected' THEN 'Rejected'
          WHEN u.verification_status = 'pending' THEN 'Pending'
          ELSE 'Under Review'
        END AS status
      FROM users u
      LEFT JOIN profiles p ON p.unique_id::text = u.unique_id::text
      WHERE u.verification_status IS NOT NULL
        AND u.verification_status = 'pending'
        AND u.role::text NOT IN ('admin', 'super_admin')
      ORDER BY u.created_at DESC
    `);

    return res.json({ data: result.rows });
  } catch (err) {
    console.error("[GetApprovalsUsers] Error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// =========================================================
// 6. GET APPROVALS BROKERAGES (Dashboard)
// =========================================================
export const getApprovalsBrokerages = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.unique_id AS id,
        COALESCE(bp.company_name, u.brokerage_name, u.name) AS company_name,
        COALESCE(p.full_name, u.name) AS owner_name,
        COALESCE(bp.registration_number, u.license_number) AS license_number,
        u.created_at,
        CASE
          WHEN u.is_verified = TRUE THEN 'Approved'
          WHEN u.verification_status = 'rejected' THEN 'Rejected'
          WHEN u.verification_status = 'pending' THEN 'Pending'
          ELSE 'Under Review'
        END AS status
      FROM users u
      LEFT JOIN profiles p ON p.unique_id::text = u.unique_id::text
      LEFT JOIN brokerage_profiles bp ON bp.unique_id::text = u.unique_id::text
      WHERE LOWER(u.role::TEXT) IN ('brokerage', 'brokerage_owner')
        AND u.verification_status = 'pending'
      ORDER BY u.created_at DESC
    `);

    return res.json({ data: result.rows });
  } catch (err) {
    console.error("[GetApprovalsBrokerages] Error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// =========================================================
// 7. GET FLAGGED LISTINGS (Dashboard)
// =========================================================
export const getFlaggedListings = async (req, res) => {
  try {
    const exists = await tableExists("safety_reports");
    if (!exists) {
      return res.json({ data: [] });
    }

    const result = await pool.query(`
      SELECT
        l.id,
        l.product_id,
        l.title,
        COALESCE(u.name, 'Unknown') AS created_by_name,
        COALESCE(sr.reason, 'Flagged') AS flagged_reason,
        COALESCE(sr.created_at, l.updated_at) AS flagged_at,
        l.status
      FROM listings l
      INNER JOIN safety_reports sr ON sr.product_id = l.product_id AND sr.report_type = 'listing'
      LEFT JOIN users u ON u.unique_id::text = l.uploaded_by_id::text
      WHERE sr.id IS NOT NULL
      ORDER BY COALESCE(sr.created_at, l.updated_at) DESC
    `);

    return res.json({ data: result.rows });
  } catch (err) {
    console.error("[GetFlaggedListings] Error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// =========================================================
// 8. GET ADMIN STATS (Dashboard)
// =========================================================
export const getAdminStats = async (req, res) => {
  try {
    const reportsTableExists = await tableExists("safety_reports");
    const flaggedListingsCount = reportsTableExists
      ? (await pool.query(
          `SELECT COUNT(DISTINCT l.id)::int AS count FROM listings l INNER JOIN safety_reports sr ON sr.product_id = l.product_id AND sr.report_type = 'listing'`
        )).rows[0]?.count || 0
      : 0;

    const [pendingUsersRes, pendingBrokeragesRes, totalApprovalsRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE verification_status = 'pending' AND role::text NOT IN ('admin', 'super_admin')`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE verification_status = 'pending' AND LOWER(role::TEXT) IN ('brokerage', 'brokerage_owner')`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE is_verified = TRUE AND role::text NOT IN ('admin', 'super_admin')`
      ),
    ]);

    return res.json({
      stats: {
        pendingUsers: pendingUsersRes.rows[0]?.count || 0,
        pendingBrokerages: pendingBrokeragesRes.rows[0]?.count || 0,
        flaggedListings: flaggedListingsCount,
        totalApprovals: totalApprovalsRes.rows[0]?.count || 0,
      },
    });
  } catch (err) {
    console.error("[GetAdminStats] Error:", err);
    return res.json({
      stats: { pendingUsers: 0, pendingBrokerages: 0, flaggedListings: 0, totalApprovals: 0 },
    });
  }
};

// =========================================================
// 9. PATCH APPROVAL USER (Dashboard approve/reject)
// =========================================================
export const patchApprovalUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, rejection_reason } = req.body;

    let newStatus;
    let isVerified;

    if (status === "Approved") {
      newStatus = "verified";
      isVerified = true;
    } else if (status === "Rejected") {
      newStatus = "rejected";
      isVerified = false;
    } else {
      return res.status(400).json({ message: "Invalid status. Use 'Approved' or 'Rejected'." });
    }

    const userRes = await pool.query(
      `SELECT unique_id, email, name, LOWER(role::TEXT) AS role, verification_status, is_verified FROM users WHERE unique_id = $1`,
      [userId]
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userRes.rows[0];

    await pool.query(
      `UPDATE users SET verification_status = $1, is_verified = $2, is_verified_agent = CASE WHEN $2 = TRUE AND LOWER(role::TEXT) LIKE '%agent%' THEN TRUE ELSE FALSE END, rejection_reason = $3, updated_at = NOW() WHERE unique_id = $4`,
      [newStatus, isVerified, rejection_reason || null, userId]
    );

    await pool.query(
      `INSERT INTO verification_history (user_id, changed_by, old_status, new_status, old_is_verified, new_is_verified, rejection_reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, req.user?.unique_id, user.verification_status, newStatus, user.is_verified, isVerified, rejection_reason || null]
    );

    const msg = isVerified
      ? `Your account has been approved.`
      : `Your account was not approved. Reason: ${rejection_reason || "Requirements not met."}`;

    await pool.query(
      `INSERT INTO notifications (recipient_id, type, title, message, created_at) VALUES ($1, 'system', 'Account Update', $2, NOW())`,
      [userId, msg]
    );

    return res.json({ success: true, message: `User ${status.toLowerCase()}` });
  } catch (err) {
    console.error("[PatchApprovalUser] Error:", err);
    return res.status(500).json({ message: "Update failed" });
  }
};

// =========================================================
// 10. DELETE FLAGGED LISTING (Dashboard)
// =========================================================
export const getAdminAnalytics = async (req, res) => {
  try {
    const [
      userStatsRes,
      listingStatsRes,
      monthlyUsersRes,
      monthlyListingsRes,
      typeDistRes,
      roleDistRes,
    ] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*)::int AS total_users,
          COUNT(*) FILTER (WHERE LOWER(role::text) IN ('agent','agency_agent','agencyagent','brokerage_agent'))::int AS total_agents,
          COUNT(*) FILTER (WHERE LOWER(role::text) = 'buyer')::int AS total_buyers,
          COUNT(*) FILTER (WHERE LOWER(role::text) IN ('brokerage','brokerage_owner'))::int AS total_brokerages,
          COUNT(*) FILTER (WHERE LOWER(role::text) IN ('admin','super_admin'))::int AS total_admins,
          COUNT(*) FILTER (WHERE is_verified = TRUE)::int AS verified_users
        FROM users`
      ),
      pool.query(
        `SELECT
          COUNT(*)::int AS total_listings,
          COUNT(*) FILTER (WHERE status = 'approved' AND is_active = TRUE)::int AS active_listings,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_listings,
          COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_listings,
          COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_listings,
          COALESCE(SUM(COALESCE(views_count,0)),0)::int AS total_views,
          COALESCE(SUM(COALESCE(saves_count,0)),0)::int AS total_saves,
          COALESCE(SUM(COALESCE(contact_count,0)),0)::int AS total_contacts
        FROM listings`
      ),
      pool.query(
        `SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          COUNT(*)::int AS registrations
        FROM users
        WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month ASC`
      ),
      pool.query(
        `SELECT
          TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
          COUNT(*)::int AS listings_created
        FROM listings
        WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month ASC`
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(property_type::text, ''), 'Other') AS label, COUNT(*)::int AS count
        FROM listings GROUP BY label ORDER BY count DESC`
      ),
      pool.query(
        `SELECT LOWER(role::text) AS label, COUNT(*)::int AS count
        FROM users GROUP BY LOWER(role::text) ORDER BY count DESC`
      ),
    ]);

    const users = userStatsRes.rows[0] || {};
    const listings = listingStatsRes.rows[0] || {};
    const userRegistrations = monthlyUsersRes.rows.map((r) => ({
      month: r.month,
      registrations: Number(r.registrations || 0),
    }));
    const listingCreation = monthlyListingsRes.rows.map((r) => ({
      month: r.month,
      listings_created: Number(r.listings_created || 0),
    }));
    const byPropertyType = { labels: typeDistRes.rows.map((r) => r.label), series: typeDistRes.rows.map((r) => Number(r.count || 0)) };
    const byUserRole = { labels: roleDistRes.rows.map((r) => r.label), series: roleDistRes.rows.map((r) => Number(r.count || 0)) };

    return res.json({
      success: true,
      analytics: {
        users: {
          total: users.total_users || 0,
          agents: users.total_agents || 0,
          buyers: users.total_buyers || 0,
          brokerages: users.total_brokerages || 0,
          admins: users.total_admins || 0,
          verified: users.verified_users || 0,
        },
        listings: {
          total: listings.total_listings || 0,
          active: listings.active_listings || 0,
          pending: listings.pending_listings || 0,
          draft: listings.draft_listings || 0,
          rejected: listings.rejected_listings || 0,
          views: listings.total_views || 0,
          saves: listings.total_saves || 0,
          contacts: listings.total_contacts || 0,
        },
        userRegistrations,
        listingCreation,
        byPropertyType,
        byUserRole,
      },
    });
  } catch (err) {
    console.error("[GetAdminAnalytics] Error:", err);
    return res.status(500).json({ success: false, error: "Failed to load analytics" });
  }
};

export const deleteFlaggedListing = async (req, res) => {
  try {
    const { listingId } = req.params;

    const result = await pool.query(
      `UPDATE listings SET is_active = FALSE, status = 'rejected', updated_at = NOW() WHERE id = $1 RETURNING product_id`,
      [listingId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Listing not found" });
    }

    return res.json({ success: true, message: "Listing removed" });
  } catch (err) {
    console.error("[DeleteFlaggedListing] Error:", err);
    return res.status(500).json({ message: "Delete failed" });
  }
};

// =========================================================
// AI MODERATION SETTINGS
// =========================================================

const AI_SETTING_KEYS = [
  "ai_auto_scan_listings",
  "ai_auto_scan_verifications",
  "ai_auto_approve_low_risk",
  "ai_auto_reject_high_risk",
  "ai_require_manual_review_medium_risk",
];

const NOTIFICATION_SETTING_KEYS = [
  "notify_admin_new_listing",
  "notify_admin_flagged_listing",
  "notify_admin_verification_submitted",
  "notify_admin_support_escalation",
];

const SECURITY_SETTING_KEYS = [
  "require_admin_reauth_for_sensitive_actions",
  "log_admin_moderation_actions",
  "restrict_private_documents_to_admins",
  "notify_super_admin_on_high_risk_override",
];

export const getAiModerationSettings = async (req, res) => {
  try {
    const settings = await getAiSettings();
    return res.json({ success: true, settings });
  } catch (err) {
    console.error("[GetAiSettings] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to load AI settings" });
  }
};

export const updateAiModerationSetting = async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!AI_SETTING_KEYS.includes(key)) {
      return res.status(400).json({ success: false, message: "Invalid AI setting key" });
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS platform_settings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key VARCHAR(100) UNIQUE NOT NULL,
      value TEXT NOT NULL,
      type VARCHAR(40) NOT NULL DEFAULT 'text',
      description TEXT,
      updated_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await pool.query(
      `INSERT INTO platform_settings (key, value, type, description)
       VALUES ($1, $2, 'boolean', '')
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
      [key, String(value), req.user?.unique_id],
    );

    return res.json({
      success: true,
      key,
      value: String(value),
      settings: { [key]: String(value) },
    });
  } catch (err) {
    console.error("[UpdateAiSetting] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update AI setting" });
  }
};

// =========================================================
// NOTIFICATION SETTINGS
// =========================================================

const ensureAppSettingsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT 'general',
      description TEXT,
      updated_by UUID REFERENCES users(unique_id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

export const getNotificationSettings = async (req, res) => {
  try {
    await ensureAppSettingsTable();

    const result = await pool.query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
      [NOTIFICATION_SETTING_KEYS],
    );

    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }

    for (const key of NOTIFICATION_SETTING_KEYS) {
      if (settings[key] === undefined) settings[key] = "true";
    }

    return res.json({ success: true, settings });
  } catch (err) {
    console.error("[GetNotificationSettings] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to load notification settings" });
  }
};

export const updateNotificationSetting = async (req, res) => {
  try {
    await ensureAppSettingsTable();

    const { key, value } = req.body;

    if (!NOTIFICATION_SETTING_KEYS.includes(key)) {
      return res.status(400).json({ success: false, message: "Invalid notification setting key" });
    }

    await pool.query(
      `INSERT INTO app_settings (key, value, group_name, description)
       VALUES ($1, $2, 'notifications', '')
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
      [key, String(value), req.user?.unique_id],
    );

    return res.json({
      success: true,
      key,
      value: String(value),
      settings: { [key]: String(value) },
    });
  } catch (err) {
    console.error("[UpdateNotificationSetting] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update notification setting" });
  }
};

// =========================================================
// SECURITY SETTINGS
// =========================================================

export const getSecuritySettings = async (req, res) => {
  try {
    await ensureAppSettingsTable();

    const result = await pool.query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
      [SECURITY_SETTING_KEYS],
    );

    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }

    for (const key of SECURITY_SETTING_KEYS) {
      if (settings[key] === undefined) settings[key] = "true";
    }

    return res.json({ success: true, settings });
  } catch (err) {
    console.error("[GetSecuritySettings] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to load security settings" });
  }
};

export const updateSecuritySetting = async (req, res) => {
  try {
    await ensureAppSettingsTable();

    const { key, value } = req.body;

    if (!SECURITY_SETTING_KEYS.includes(key)) {
      return res.status(400).json({ success: false, message: "Invalid security setting key" });
    }

    await pool.query(
      `INSERT INTO app_settings (key, value, group_name, description)
       VALUES ($1, $2, 'security', '')
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
      [key, String(value), req.user?.unique_id],
    );

    return res.json({
      success: true,
      key,
      value: String(value),
      settings: { [key]: String(value) },
    });
  } catch (err) {
    console.error("[UpdateSecuritySetting] Error:", err);
    return res.status(500).json({ success: false, message: "Failed to update security setting" });
  }
};
